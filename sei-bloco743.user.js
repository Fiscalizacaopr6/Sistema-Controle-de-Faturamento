// ==UserScript==
// @name         SEI UFRJ — Bloco 743 → Folha de Informação no Controle de Faturamento
// @namespace    https://fiscalizacaopr6.github.io/
// @version      1.1.0
// @description  Lê o bloco de assinatura 743 (Pagamento de Notas Fiscais e Movimentação de Conta Vinculada) e lança o número de cada Folha de Informação na coluna "Folha de Informação" da tela Documentos, no contrato/competência/unidade que a própria folha informa.
// @author       Fiscalização PR6 / UFRJ
// @match        https://sei.ufrj.br/sei/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/sei-bloco743.user.js
// @updateURL    https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/sei-bloco743.user.js
// ==/UserScript==

/*
 * O que faz
 *   Toda folha de informação que entra no bloco 743 tem o número gravado em
 *   `folhaInfo` das linhas da tela Documentos a que ela se refere (a situação
 *   passa a "BLOCO 743" sozinha, pela regra do sistema).
 *
 * Quando roda
 *   - ao abrir o próprio bloco 743 no SEI: lança e mostra um painel com o
 *     resultado de cada folha;
 *   - em qualquer outra página do SEI, no máximo a cada 10 minutos, em segundo
 *     plano (só avisa se lançou alguma coisa).
 *
 * De onde vêm contrato, mês e unidade: da PRÓPRIA folha de informação
 *   (aberta pelo link de navegação do bloco, o mesmo que o SEI usa para assinar):
 *   - contrato: célula CONTRATO do cabeçalho da folha;
 *   - tabela "NOTA FISCAL PARA LIQUIDAÇÃO DA DESPESA": cada linha tem
 *     COMPETÊNCIA (o mês), UNIDADE(S) e FATURA (o nº da NF).
 *   Para cada linha da tabela, as linhas da tela Documentos são:
 *     1. as do contrato nessa competência cuja Nota Fiscal = FATURA;
 *     2. se a NF ainda não foi lançada no sistema: as linhas sem folha dessa
 *        competência cuja unidade bate com a unidade da folha (nome, parte do
 *        nome ou sigla — "PU" = PREFEITURA UNIVERSITÁRIA); "TODAS"/"UFRJ" = todas;
 *        se o mês só tem uma linha sem folha, é ela.
 *   Linhas da tabela que não são competência mensal (Repactuação, Serviço
 *   eventual, Diferença…) são ignoradas. Folha sem essa tabela (conta
 *   vinculada etc.) não é lançada. Nunca sobrescreve uma folha já lançada.
 *
 * Gravação: PATCH em /documentos_edits com o registro inteiro (base + folha),
 * relido do Firebase na hora; registro em /auditoria/edicoes.
 *
 * Diagnóstico no console (F12) de uma página do SEI:
 *   window.__pr6Bloco743                 → versão instalada
 *   window.__pr6Bloco743Simular()        → mostra o que lançaria, sem gravar
 *   window.__pr6Bloco743Log()            → últimas execuções
 */

(function () {
  'use strict';

  if (window.top !== window.self) return;

  var VERSAO   = '1.1.0';
  var BLOCO    = '743';
  var FB       = 'https://fiscalizacao-d9a39-default-rtdb.firebaseio.com';
  var BASE_URL = 'https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/documentos-data.js';
  var INTERVALO_MS = 10 * 60 * 1000;
  var TRAVA_MS     = 5 * 60 * 1000;
  var CACHE_MS     = 30 * 60 * 1000;   // conteúdo de folha pendente é relido após 30 min
  var K_ULTIMA = 'pr6_b743_ultima';
  var K_TRAVA  = 'pr6_b743_trava';
  var K_LOG    = 'pr6_b743_log';
  var K_CACHE  = 'pr6_b743_folhas';
  var K_URL    = 'pr6_b743_url';      // sessionStorage: link do bloco (hash vale na sessão)

  try { window.__pr6Bloco743 = VERSAO; } catch (e) {}

  var MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO',
               'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  var ABREV = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  // competência: começa pelo mês e traz o ano ("OUTUBRO/2026", "Outubro/26",
  // "OUTUBRO 2026", "Outubro de 2026", "OUT/26")
  var COMP_RE = new RegExp('^(' + MESES.join('|') + '|' + ABREV.join('|') + ')\\.?\\s*(?:\\/|-|DE)?\\s*(\\d{4}|\\d{2})(?!\\d)');
  var NAO_MENSAL = /REPACTUA|DIFEREN|EVENTUAL|RETROATIV|\sA\s.*\d/;
  var GENERICAS = /^(UFRJ|TODAS?|TODOS|TODAS AS UNIDADES|TODOS OS LOCAIS|VARIAS UNIDADES)$/;
  var ACENTOS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

  // ── utilidades ──
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(ACENTOS, '')
      .toUpperCase().replace(/\s+/g, ' ').trim();
  }
  // nome de unidade comparável: sem acento, sem pontuação
  function normUn(s) { return norm(s).replace(/[^A-Z0-9]+/g, ' ').trim(); }
  function soDigitos(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function vazio(v) { return !String(v == null ? '' : v).trim(); }
  function texto(el) { return el ? String(el.innerText || el.textContent || '') : ''; }
  function numerosDoc(v) {
    return String(v == null ? '' : v).split(/[\/,;\s]+/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return soDigitos(t).length >= 4; });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
    });
  }
  function unicos(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function log(ev, info) {
    try {
      var l = JSON.parse(localStorage.getItem(K_LOG) || '[]');
      l.push({t: new Date().toLocaleString('pt-BR'), ev: ev, info: info});
      localStorage.setItem(K_LOG, JSON.stringify(l.slice(-30)));
    } catch (e) {}
  }
  try {
    window.__pr6Bloco743Log = function () {
      var l = []; try { l = JSON.parse(localStorage.getItem(K_LOG) || '[]'); } catch (e) {}
      if (console.table) console.table(l);
      return l;
    };
  } catch (e) {}

  // páginas do SEI vêm em ISO-8859-1
  function htmlDe(url, opts) {
    return fetch(url, Object.assign({credentials: 'same-origin'}, opts || {})).then(function (r) {
      if (!r.ok) throw new Error('SEI HTTP ' + r.status);
      var ct = r.headers.get('content-type') || '';
      var cs = (ct.match(/charset=([\w-]+)/i) || [])[1] || 'iso-8859-1';
      return r.arrayBuffer().then(function (b) {
        return new DOMParser().parseFromString(new TextDecoder(cs).decode(b), 'text/html');
      });
    });
  }
  function abs(href) { return new URL(href, location.href).href; }
  function fbGet(caminho) {
    return fetch(FB + '/' + caminho + '.json', {cache: 'no-store'}).then(function (r) {
      if (!r.ok) throw new Error('Firebase HTTP ' + r.status);
      return r.json();
    });
  }
  function fbEnviar(metodo, caminho, corpo) {
    return fetch(FB + '/' + caminho + '.json', {
      method: metodo, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(corpo)
    }).then(function (r) {
      if (!r.ok) throw new Error('Firebase HTTP ' + r.status);
      return r.json();
    });
  }

  // ── localizar o bloco 743 ──
  function ehPaginaDoBloco(doc, url) {
    return /acao=rel_bloco_protocolo_listar/.test(url) && new RegExp('[?&]id_bloco=' + BLOCO + '(&|$)').test(url)
      && !!doc.querySelector('table.infraTable');
  }
  function linkBlocoNaLista(doc) {
    var re = new RegExp('[?&]id_bloco=' + BLOCO + '(&|$)');
    var a = Array.prototype.find.call(doc.querySelectorAll('a[href*="rel_bloco_protocolo_listar"]'),
      function (x) { return re.test(x.getAttribute('href')); });
    return a ? abs(a.getAttribute('href')) : null;
  }
  function paginaDaLista(doc, pag) {
    var f = doc.querySelector('#frmBlocoLista');
    if (!f) return Promise.resolve(null);
    var fd = new FormData(f), corpo = new URLSearchParams();
    fd.set('hdnInfraPaginaAtual', pag);
    fd.set('selInfraPaginacaoSuperior', pag);
    fd.set('selInfraPaginacaoInferior', pag);
    fd.forEach(function (v, k) { corpo.append(k, v); });
    return htmlDe(abs(f.getAttribute('action')), {
      method: 'POST', body: corpo, headers: {'Content-Type': 'application/x-www-form-urlencoded'}
    });
  }
  function acharUrlDoBloco() {
    var guardada = null;
    try { guardada = sessionStorage.getItem(K_URL); } catch (e) {}
    if (guardada) return Promise.resolve(guardada);
    var menu = document.querySelector('a[href*="acao=bloco_assinatura_listar"]');
    if (!menu) return Promise.resolve(null);
    return htmlDe(menu.href).then(function (lista) {
      var u = linkBlocoNaLista(lista);
      if (u) return u;
      var sel = lista.querySelector('#selInfraPaginacaoSuperior');
      var n = sel ? sel.options.length : 1;
      // o 743 é antigo: costuma estar na última página — começa por ela
      var ordem = [];
      for (var p = n - 1; p >= 1; p--) ordem.push(p);
      return (function proxima(i) {
        if (i >= ordem.length) return null;
        return paginaDaLista(lista, ordem[i]).then(function (d) {
          var achou = d && linkBlocoNaLista(d);
          return achou || proxima(i + 1);
        });
      })(0);
    }).then(function (u) {
      if (u) { try { sessionStorage.setItem(K_URL, u); } catch (e) {} }
      return u;
    });
  }

  // ── ler as linhas do bloco ──
  function lerBloco(doc) {
    var t = doc.querySelector('table.infraTable');
    if (!t || !t.rows.length) return null;
    var cab = Array.prototype.map.call(t.rows[0].cells, function (c) { return norm(c.textContent); });
    function col(re) { for (var i = 0; i < cab.length; i++) if (re.test(cab[i])) return i; return -1; }
    var iProc = col(/^PROCESSO/), iDoc = col(/^DOCUMENTO/), iTipo = col(/^TIPO/), iAnot = col(/^ANOTA/);
    if (iDoc < 0 || iTipo < 0) return null;
    var out = [];
    for (var r = 1; r < t.rows.length; r++) {
      var tr = t.rows[r], c = tr.cells;
      if (!c[iDoc]) continue;
      // link de navegação do bloco: abre o conteúdo da folha sem abrir o processo
      var nav = '', a = tr.querySelector('a[onclick*="bloco_navegar"]');
      var m = a && a.getAttribute('onclick').match(/'(controlador\.php\?acao=bloco_navegar[^']+)'/);
      if (m) nav = abs(m[1].replace(/&amp;/g, '&'));
      out.push({
        doc: c[iDoc].textContent.trim(),
        tipo: c[iTipo].textContent.trim(),
        processo: iProc >= 0 ? c[iProc].textContent.trim() : '',
        anotacao: iAnot >= 0 ? texto(c[iAnot]).replace(/\r/g, '').trim() : '',
        nav: nav
      });
    }
    return out;
  }

  // ── conteúdo da folha: contrato + tabela de NF ──
  function lerConteudoFolha(doc) {
    var out = {contrato: '', nfs: [], tabela: false};
    var idx = null;   // colunas do cabeçalho COMPETÊNCIA | UNIDADE(S) | FATURA da vez
    Array.prototype.forEach.call(doc.querySelectorAll('table'), function (t) {
      var linhas = Array.prototype.map.call(t.rows, function (r) {
        return Array.prototype.map.call(r.cells, function (c) { return texto(c).replace(/\r/g, '').trim(); });
      });
      linhas.forEach(function (cel, k) {
        var up = cel.map(norm);
        var ic = up.indexOf('CONTRATO');
        if (ic >= 0 && !out.contrato && linhas[k + 1] && linhas[k + 1][ic]) out.contrato = contratoNorm(linhas[k + 1][ic]);
        var iComp = -1, iUni = -1, iFat = -1;
        up.forEach(function (x, i) {
          if (/^COMPETENCIA/.test(x)) iComp = i;
          else if (/^UNIDADE/.test(x)) iUni = i;
          else if (/^(FATURA|NOTA FISCAL|N\W*F\W*$|NF)/.test(x)) iFat = i;
        });
        if (iComp >= 0) { idx = {comp: iComp, uni: iUni, fat: iFat}; out.tabela = true; return; }
        if (!idx) return;
        if (cel.length <= Math.max(idx.comp, idx.uni, idx.fat)) { idx = null; return; }
        var comp = cel[idx.comp];
        if (vazio(comp)) return;
        out.nfs.push({comp: comp, unidades: idx.uni >= 0 ? cel[idx.uni] : '', fatura: idx.fat >= 0 ? cel[idx.fat] : ''});
      });
      idx = null;
    });
    return out;
  }

  function cacheLer() { try { return JSON.parse(localStorage.getItem(K_CACHE) || '{}'); } catch (e) { return {}; } }
  function cacheGravar(c) {
    try {
      var ks = Object.keys(c).sort(function (a, b) { return c[b].t - c[a].t; });
      var novo = {}; ks.slice(0, 200).forEach(function (k) { novo[k] = c[k]; });
      localStorage.setItem(K_CACHE, JSON.stringify(novo));
    } catch (e) {}
  }

  // lê as folhas uma a uma (o SEI atende uma requisição por vez na sessão)
  function lerFolhas(folhas, progresso) {
    var cache = cacheLer(), agora = Date.now(), i = 0;
    return (function proxima() {
      if (i >= folhas.length) { cacheGravar(cache); return Promise.resolve(); }
      var f = folhas[i++];
      if (progresso) progresso(i, folhas.length);
      var c = cache[f.doc];
      if (c && agora - c.t < CACHE_MS) { f.conteudo = c.v; return proxima(); }
      if (!f.nav) { f.erroLeitura = 'sem link de navegação do bloco'; return proxima(); }
      return htmlDe(f.nav).then(function (d) {
        var ifr = d.querySelector('iframe[src*="documento_visualizar"]');
        if (!ifr) throw new Error('folha sem visualização');
        return htmlDe(abs(ifr.getAttribute('src')));
      }).then(function (d) {
        f.conteudo = lerConteudoFolha(d);
        cache[f.doc] = {t: Date.now(), v: f.conteudo};
      }).catch(function (e) {
        f.erroLeitura = String(e && e.message || e);
      }).then(proxima);
    })();
  }

  // ── dados do sistema ──
  function carregarSistema() {
    return Promise.all([
      fetch(BASE_URL).then(function (r) { if (!r.ok) throw new Error('base HTTP ' + r.status); return r.text(); }),
      fbGet('documentos_edits'),
      fbGet('dados')
    ]).then(function (res) {
      var txt = res[0];
      var cols = JSON.parse(txt.match(/var\s+DOC_COLS\s*=\s*(\[[\s\S]*?\])\s*;/)[1]);
      var i = txt.indexOf('var DOC_ROWS'), j = txt.indexOf('[', i), k = txt.lastIndexOf(']');
      var linhas = JSON.parse(txt.slice(j, k + 1));
      var base = {}, estado = {};
      linhas.forEach(function (l) {
        var o = {id: l[0]};
        cols.forEach(function (c, n) { o[c] = l[n + 1]; });
        base[o.id] = o; estado[o.id] = o;
      });
      var ed = res[1] || {};
      Object.keys(ed).forEach(function (id) {
        var v = ed[id];
        if (!v) return;
        if (v._del) delete estado[id];
        else estado[id] = Object.assign({id: id}, v);
      });
      var dados = res[2] || [];
      dados = Array.isArray(dados) ? dados.filter(Boolean) : Object.keys(dados).map(function (x) { return dados[x]; });
      return {base: base, estado: estado, lista: Object.keys(estado).map(function (x) { return estado[x]; }), dados: dados};
    });
  }

  function contratoNorm(s) {
    var m = String(s || '').match(/(\d{1,3})\s*\/\s*(\d{4}|\d{2})(?!\d)/);
    return m ? (('0' + parseInt(m[1], 10)).slice(-2) + '/' + m[2].slice(-2)) : '';
  }
  function contratosDoProcesso(dados, processo) {
    var alvo = soDigitos(processo);
    if (alvo.length < 15) return [];
    var achou = {};
    dados.forEach(function (d) {
      var v = String(d['PROCESSO PAGAMENTO'] || '');
      var tem = v.split(/[^\d.\/-]+/).some(function (p) { return soDigitos(p) === alvo; });
      if (tem && d.CONTRATO) achou[contratoNorm(d.CONTRATO) || String(d.CONTRATO).trim()] = 1;
    });
    return Object.keys(achou);
  }

  function competencia(s) {
    var n = norm(s);
    if (NAO_MENSAL.test(n)) return null;
    var m = n.match(COMP_RE);
    if (!m) return null;
    var idx = MESES.indexOf(m[1]); if (idx < 0) idx = ABREV.indexOf(m[1]);
    return {mes: MESES[idx], ano: m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10)};
  }

  // nomes de unidade escritos na folha ("CCJE E PALÁCIO", "PU, SIARQ, STIC",
  // "MACAÉ ( NUPEM / AJUDA )") → lista normalizada
  function unidadesDaFolha(s) {
    return unicos(String(s || '').split(/\n|;|,|\/|\(|\)|\s+[eE]\s+|\s+-\s+/)
      .map(normUn).filter(function (x) { return x.length >= 2; }));
  }
  function sigla(nome) {
    return nome.split(' ').filter(function (w) { return w && !/^(DE|DA|DO|DAS|DOS|E)$/.test(w); })
      .map(function (w) { return w[0]; }).join('');
  }
  function unidadeCasa(unSistema, toks) {
    var su = normUn(unSistema);
    if (!su) return false;
    var sg = sigla(su);
    return toks.some(function (t) {
      return t === su || (' ' + su + ' ').indexOf(' ' + t + ' ') >= 0 || (' ' + t + ' ').indexOf(' ' + su + ' ') >= 0
        || (sg.length >= 2 && sg === t.replace(/ /g, ''));
    });
  }

  // ── decide as linhas de Documentos de uma folha ──
  function planejar(f, sis) {
    var r = {doc: f.doc, processo: f.processo, anotacao: f.anotacao.split('\n')[0], linhas: [], avisos: []};
    var jaTem = sis.lista.filter(function (o) { return numerosDoc(o.folhaInfo).indexOf(f.doc) >= 0; });
    if (jaTem.length) {
      r.status = 'ja';
      r.contrato = jaTem[0].contrato;
      r.detalhe = jaTem.map(function (o) { return o.mes + '/' + o.ano + ' ' + o.unidade; }).join(', ');
      return r;
    }
    if (f.erroLeitura) { r.status = 'pend'; r.detalhe = 'não consegui abrir a folha: ' + f.erroLeitura; return r; }
    var ct = f.conteudo || {nfs: []};
    if (!ct.tabela) { r.status = 'pula'; r.detalhe = 'folha sem tabela de nota fiscal (conta vinculada, medição…)'; return r; }

    // contrato: o da folha; sem ele, o do processo
    var porProc = contratosDoProcesso(sis.dados, f.processo);
    var contrato = ct.contrato || (porProc.length === 1 ? porProc[0] : '');
    if (!contrato) { r.status = 'pend'; r.detalhe = 'contrato não identificado na folha nem pelo processo'; return r; }
    r.contrato = contrato;
    var doContrato = sis.lista.filter(function (o) { return contratoNorm(o.contrato) === contrato; });
    if (!doContrato.length) { r.status = 'pend'; r.detalhe = 'contrato ' + contrato + ' sem linhas na tela Documentos'; return r; }

    var escolhidas = {}, partes = [], ignoradas = [];
    ct.nfs.forEach(function (nf) {
      var cp = competencia(nf.comp);
      var rotulo = String(nf.comp).replace(/\s+/g, ' ').trim();
      if (!cp) { ignoradas.push(rotulo.slice(0, 40)); return; }
      var doMes = doContrato.filter(function (o) { return norm(o.mes) === cp.mes && String(o.ano) === String(cp.ano); });
      var ref = cp.mes + '/' + cp.ano + (soDigitos(nf.fatura) ? ' NF ' + nf.fatura.replace(/\s+/g, ' ') : '');
      if (!doMes.length) { r.avisos.push(ref + ': sem linha na tela Documentos'); return; }
      var fat = soDigitos(nf.fatura).replace(/^0+/, '');
      var alvo = fat ? doMes.filter(function (o) { return soDigitos(o.notaFiscal).replace(/^0+/, '') === fat; }) : [];
      var como = 'pela NF';
      if (!alvo.length) {
        var livres = doMes.filter(function (o) { return vazio(o.folhaInfo) && vazio(o.semPrestacao); });
        var toks = unidadesDaFolha(nf.unidades);
        if (toks.some(function (t) { return GENERICAS.test(t); })) {
          var semNf = livres.filter(function (o) { return vazio(o.notaFiscal); });
          alvo = semNf.length ? semNf : livres; como = 'todas as unidades';
        } else {
          alvo = livres.filter(function (o) { return unidadeCasa(o.unidade, toks); }); como = 'pela unidade';
          if (!alvo.length && livres.length === 1) { alvo = livres; como = 'única linha do mês'; }
        }
      }
      if (!alvo.length) { r.avisos.push(ref + ' (' + String(nf.unidades).replace(/\s+/g, ' ').slice(0, 50) + '): unidade não encontrada'); return; }
      var outra = alvo.filter(function (o) { return !vazio(o.folhaInfo); });
      if (outra.length) r.avisos.push(ref + ': ' + outra.length + ' linha(s) já com a folha ' + unicos(outra.map(function (o) { return o.folhaInfo; })).join(', '));
      var novas = alvo.filter(function (o) { return vazio(o.folhaInfo) && vazio(o.semPrestacao) && !escolhidas[o.id]; });
      novas.forEach(function (o) { escolhidas[o.id] = o; });
      if (novas.length) partes.push(ref + ' → ' + novas.map(function (o) { return o.unidade; }).join(', ') + ' (' + como + ')');
    });
    if (ignoradas.length) r.avisos.push('ignorado(s): ' + ignoradas.join('; '));

    r.linhas = Object.keys(escolhidas);
    if (!r.linhas.length) {
      r.status = ct.nfs.length && ignoradas.length === ct.nfs.length ? 'pula' : 'pend';
      r.detalhe = r.status === 'pula' ? 'nenhuma competência mensal na tabela (repactuação, serviço eventual…)'
        : (r.avisos.shift() || 'nenhuma linha correspondente');
      return r;
    }
    r.status = 'ok';
    r.detalhe = partes.join(' · ');
    return r;
  }

  // ── gravação ──
  function nomeUsuarioSei() {
    var a = document.getElementById('lnkUsuarioSistema');
    return a ? String(a.title || a.textContent || '').replace(/\s*\(.*$/, '').trim() : '';
  }
  function gravar(planos, sis) {
    var ids = [], porId = {};
    planos.forEach(function (p) {
      if (p.status !== 'ok') return;
      p.linhas.forEach(function (id) { ids.push(id); porId[id] = p; });
    });
    if (!ids.length) return Promise.resolve(0);
    // relê cada registro na hora: alguém pode ter editado a linha agora há pouco
    return Promise.all(ids.map(function (id) {
      return fbGet('documentos_edits/' + encodeURIComponent(id)).then(function (atual) {
        if (atual && atual._del) return null;
        var rec = atual ? Object.assign({}, atual) : Object.assign({}, sis.base[id]);
        if (!rec || !rec.contrato) return null;
        if (!vazio(rec.folhaInfo)) return null;            // preenchida nesse meio-tempo
        rec.id = id;
        rec.folhaInfo = porId[id].doc;
        return rec;
      });
    })).then(function (recs) {
      var pacote = {}, mud = [];
      recs.forEach(function (rec) {
        if (!rec) return;
        pacote[rec.id] = rec;
        mud.push({r: [rec.contrato, rec.unidade + ' ' + rec.mes + '/' + rec.ano].join(' · ').slice(0, 140),
                  c: 'folhaInfo', de: '∅', para: rec.folhaInfo});
      });
      var n = Object.keys(pacote).length;
      if (!n) return 0;
      return fbEnviar('PATCH', 'documentos_edits', pacote).then(function () {
        var agora = new Date(), p2 = function (x) { return ('0' + x).slice(-2); };
        var reg = {login: 'sei-bloco743', nome: (nomeUsuarioSei() || 'SEI') + ' (SEI · bloco ' + BLOCO + ')',
                   ts: agora.getTime(), tela: 'documentos', no: 'documentos_edits', caminho: 'documentos_edits',
                   acao: 'alteração', total: mud.length, mudancas: mud.slice(0, 40)};
        if (mud.length && mud.every(function (m) { return m.r === mud[0].r; })) reg.registro = mud[0].r;
        return fbEnviar('POST', 'auditoria/edicoes/' + agora.getFullYear() + '-' + p2(agora.getMonth() + 1) + '/' + p2(agora.getDate()), reg)
          .catch(function (e) { log('auditoria falhou', String(e)); })
          .then(function () { return n; });
      });
    });
  }

  // ── execução ──
  function obterDocDoBloco() {
    if (ehPaginaDoBloco(document, location.href)) return Promise.resolve(document);
    return acharUrlDoBloco().then(function (u) {
      if (!u) return null;
      return htmlDe(u).then(function (d) {
        if (d.querySelector('table.infraTable') && /Processos\/Documentos/i.test((d.querySelector('table.infraTable caption') || {}).textContent || '')) return d;
        try { sessionStorage.removeItem(K_URL); } catch (e) {}    // hash vencido: acha de novo
        return acharUrlDoBloco().then(function (u2) { return u2 ? htmlDe(u2) : null; });
      });
    });
  }

  function sincronizar(opts) {
    opts = opts || {};
    return obterDocDoBloco().then(function (doc) {
      if (!doc) throw new Error('bloco ' + BLOCO + ' não encontrado (sessão do SEI expirada?)');
      var folhas = lerBloco(doc);
      if (!folhas) throw new Error('não consegui ler a tabela do bloco ' + BLOCO);
      var infos = folhas.filter(function (f) { return /INFORMACAO/.test(norm(f.tipo)); });
      return carregarSistema().then(function (sis) {
        // só abre o conteúdo das folhas que ainda não estão no sistema
        var lancadas = {};
        sis.lista.forEach(function (o) { numerosDoc(o.folhaInfo).forEach(function (n) { lancadas[n] = 1; }); });
        var aLer = infos.filter(function (f) { return !lancadas[f.doc]; });
        return lerFolhas(aLer, opts.progresso).then(function () {
          var planos = infos.map(function (f) { return planejar(f, sis); });
          var res = {folhas: folhas.length, informacao: infos.length, planos: planos, gravadas: 0};
          if (opts.simular) return res;
          return gravar(planos, sis).then(function (n) {
            res.gravadas = n;
            log('sincronizado', n + ' linha(s) gravada(s); ' + planos.filter(function (p) { return p.status === 'ok'; }).length + ' folha(s) lançada(s)');
            return res;
          });
        });
      });
    });
  }

  try {
    window.__pr6Bloco743Simular = function () {
      return sincronizar({simular: true}).then(function (r) {
        if (console.table) console.table(r.planos.map(function (p) {
          return {doc: p.doc, status: p.status, contrato: p.contrato || '', detalhe: p.detalhe || '', avisos: p.avisos.join(' | ')};
        }));
        return r;
      });
    };
  } catch (e) {}

  // ── painel na página do bloco ──
  var ROTULO = {ok: ['✔ Lançada', '#1b7a3a', '#e9f6ee'], ja: ['• Já estava no sistema', '#456', '#f1f4f8'],
                pula: ['— Ignorada', '#777', '#f6f6f6'], pend: ['⚠ Não lançada', '#a35a00', '#fff4e5']};
  function painel(res, erro, progresso) {
    var antigo = document.getElementById('pr6-b743'); if (antigo) antigo.parentNode.removeChild(antigo);
    var cx = document.createElement('div');
    cx.id = 'pr6-b743';
    cx.style.cssText = 'margin:10px 0 14px;border:1px solid #c3d4e6;border-left:4px solid #0a6ca8;border-radius:6px;'
      + 'background:#fff;padding:10px 12px;font:13px Arial,sans-serif;color:#123';
    var html = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">'
      + '<b>Controle de Faturamento — Folhas de Informação do bloco ' + BLOCO + '</b>'
      + '<span><button id="pr6-b743-de-novo" style="cursor:pointer;border:1px solid #0a6ca8;background:#0a6ca8;color:#fff;border-radius:4px;padding:3px 9px;font:600 12px Arial">Verificar de novo</button> '
      + '<button id="pr6-b743-fechar" style="cursor:pointer;border:1px solid #c3d4e6;background:#fff;color:#456;border-radius:4px;padding:3px 9px;font:600 12px Arial">Ocultar</button></span></div>';
    if (erro) {
      html += '<div style="color:#a00">Não foi possível sincronizar: ' + esc(erro) + '</div>';
    } else if (!res) {
      html += '<div id="pr6-b743-prog" style="color:#567">' + esc(progresso || 'Conferindo com a tela Documentos…') + '</div>';
    } else {
      var cont = {ok: 0, ja: 0, pula: 0, pend: 0};
      res.planos.forEach(function (p) { cont[p.status]++; });
      html += '<div style="color:#567;margin-bottom:6px">' + res.informacao + ' folha(s) de informação · '
        + '<b style="color:#1b7a3a">' + cont.ok + ' lançada(s) agora</b> (' + res.gravadas + ' linha(s)) · '
        + cont.ja + ' já no sistema · <b style="color:#a35a00">' + cont.pend + ' sem lançar</b> · ' + cont.pula + ' ignorada(s)</div>';
      var ordem = {pend: 0, ok: 1, pula: 2, ja: 3};
      var ps = res.planos.slice().sort(function (a, b) { return ordem[a.status] - ordem[b.status]; });
      html += '<table style="border-collapse:collapse;width:100%;font-size:12px">'
        + '<tr style="text-align:left;color:#567"><th style="padding:3px 6px">Documento</th><th style="padding:3px 6px">Situação</th>'
        + '<th style="padding:3px 6px">Contrato</th><th style="padding:3px 6px">Linhas / motivo</th><th style="padding:3px 6px">Anotação</th></tr>';
      ps.forEach(function (p) {
        var rt = ROTULO[p.status];
        html += '<tr style="border-top:1px solid #e3e9f0;background:' + rt[2] + '">'
          + '<td style="padding:3px 6px;font-family:monospace">' + esc(p.doc) + '</td>'
          + '<td style="padding:3px 6px;color:' + rt[1] + ';white-space:nowrap;font-weight:600">' + rt[0] + '</td>'
          + '<td style="padding:3px 6px;white-space:nowrap">' + esc(p.contrato || '—') + '</td>'
          + '<td style="padding:3px 6px">' + esc(p.detalhe || '')
          + p.avisos.map(function (a) { return '<div style="color:#a35a00">' + esc(a) + '</div>'; }).join('') + '</td>'
          + '<td style="padding:3px 6px;color:#567">' + esc(p.anotacao || '') + '</td></tr>';
      });
      html += '</table>';
    }
    cx.innerHTML = html;
    var tabela = document.querySelector('table.infraTable');
    var ancora = tabela ? (tabela.closest('.infraAreaTabela') || tabela) : null;
    if (ancora && ancora.parentNode) ancora.parentNode.insertBefore(cx, ancora);
    else document.body.insertBefore(cx, document.body.firstChild);
    document.getElementById('pr6-b743-fechar').onclick = function () { cx.parentNode.removeChild(cx); };
    document.getElementById('pr6-b743-de-novo').onclick = function () { rodar(true); };
  }

  function toast(msg) {
    if (!document.body) return;
    var cx = document.createElement('div');
    cx.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:420px;background:#fff;'
      + 'border:1px solid #c3d4e6;border-left:4px solid #1b7a3a;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);'
      + 'padding:10px 12px;font:13px Arial,sans-serif;color:#123;cursor:pointer';
    cx.innerHTML = msg;
    cx.title = 'Clique para fechar';
    cx.onclick = function () { cx.parentNode.removeChild(cx); };
    document.body.appendChild(cx);
    setTimeout(function () { if (cx.parentNode) cx.parentNode.removeChild(cx); }, 15000);
  }

  function travar() {
    try {
      var t = parseInt(localStorage.getItem(K_TRAVA) || '0', 10);
      if (Date.now() - t < TRAVA_MS) return false;
      localStorage.setItem(K_TRAVA, String(Date.now()));
      return true;
    } catch (e) { return true; }
  }
  function destravar() { try { localStorage.removeItem(K_TRAVA); } catch (e) {} }

  function rodar(naPagina) {
    if (naPagina) painel(null);
    if (!travar()) {
      if (naPagina) setTimeout(function () { rodar(true); }, 5000);
      return;
    }
    var opts = {};
    if (naPagina) opts.progresso = function (i, n) {
      var el = document.getElementById('pr6-b743-prog');
      if (el) el.textContent = 'Lendo as folhas no SEI (' + i + ' de ' + n + ')…';
    };
    sincronizar(opts).then(function (res) {
      destravar();
      try { localStorage.setItem(K_ULTIMA, String(Date.now())); } catch (e) {}
      if (naPagina) { painel(res); return; }
      var ok = res.planos.filter(function (p) { return p.status === 'ok'; });
      if (ok.length) {
        toast('<b>Bloco ' + BLOCO + ' → Controle de Faturamento</b><br>' + ok.map(function (p) {
          return 'Folha <b>' + esc(p.doc) + '</b> lançada no ' + esc(p.contrato) + ' (' + esc(p.detalhe) + ')';
        }).join('<br>'));
      }
    }).catch(function (e) {
      destravar();
      log('erro', String(e && e.message || e));
      if (naPagina) painel(null, String(e && e.message || e));
    });
  }

  function iniciar() {
    if (/\/sip\//.test(location.pathname)) return;
    if (ehPaginaDoBloco(document, location.href)) {
      try { sessionStorage.setItem(K_URL, location.href); } catch (e) {}
      rodar(true);
      return;
    }
    if (!document.querySelector('a[href*="acao=bloco_assinatura_listar"]')) return;   // página sem menu
    var ultima = 0;
    try { ultima = parseInt(localStorage.getItem(K_ULTIMA) || '0', 10); } catch (e) {}
    if (Date.now() - ultima < INTERVALO_MS) return;
    rodar(false);
  }

  try { window.__pr6Bloco743Interno = {sincronizar: sincronizar, planejar: planejar, lerConteudoFolha: lerConteudoFolha, competencia: competencia, unidadesDaFolha: unidadesDaFolha}; } catch (e) {}

  if (window.__pr6Bloco743SemAuto) return;
  if (document.readyState === 'complete') setTimeout(iniciar, 500);
  else window.addEventListener('load', function () { setTimeout(iniciar, 500); });
})();
