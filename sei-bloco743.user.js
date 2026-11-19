// ==UserScript==
// @name         SEI UFRJ — Bloco 743 → Folha de Informação no Controle de Faturamento
// @namespace    https://fiscalizacaopr6.github.io/
// @version      1.0.0
// @description  Lê o bloco de assinatura 743 (Pagamento de Notas Fiscais e Movimentação de Conta Vinculada) e lança o número de cada Folha de Informação na coluna "Folha de Informação" da tela Documentos, no contrato/mês certos.
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
 *   `folhaInfo` das linhas da tela Documentos daquele contrato/mês (situação
 *   passa a "BLOCO 743" sozinha, pela regra do sistema).
 *
 * Quando roda
 *   - ao abrir o próprio bloco 743 no SEI: lança e mostra um painel com o
 *     resultado de cada folha;
 *   - em qualquer outra página do SEI, no máximo a cada 10 minutos, em segundo
 *     plano (só avisa se lançou alguma coisa).
 *
 * Como acha o contrato e o mês de cada folha
 *   contrato: o processo da folha é o PROCESSO PAGAMENTO de qual contrato (nó
 *             /dados)? Se o processo não resolve sozinho, vale o "NN/AA" do
 *             início da anotação do bloco.
 *   mês/ano:  meses escritos na anotação ("Pagamento - Outubro 2026",
 *             "OUT 26", "Setembro/ Outubro 2026"). Linha da anotação que cita
 *             uma unidade ("Macaé - Junho, Julho e Agosto/2026") vale só para
 *             aquela unidade. Sem mês na anotação: usa o único mês do contrato
 *             que já tem NF lançada e ainda está sem folha; se houver mais de
 *             um, não lança.
 *   Não lança: folha de atesto; anotação de conta vinculada, repactuação,
 *             correção, férias, 13º, rescisão; processo de conta vinculada;
 *             linha que já tem outra folha (nunca sobrescreve).
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

  var VERSAO   = '1.0.0';
  var BLOCO    = '743';
  var FB       = 'https://fiscalizacao-d9a39-default-rtdb.firebaseio.com';
  var BASE_URL = 'https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/documentos-data.js';
  var INTERVALO_MS = 10 * 60 * 1000;
  var TRAVA_MS     = 90 * 1000;
  var K_ULTIMA = 'pr6_b743_ultima';
  var K_TRAVA  = 'pr6_b743_trava';
  var K_LOG    = 'pr6_b743_log';
  var K_URL    = 'pr6_b743_url';      // sessionStorage: link do bloco (hash vale na sessão)

  try { window.__pr6Bloco743 = VERSAO; } catch (e) {}

  var MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO',
               'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  var ABREV = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  // mês + ano opcional ("OUTUBRO 2026", "OUT/26", "OUTUBRO DE 2026"); o separador só
  // é consumido junto com o ano, senão engoliria a "/" de "SETEMBRO/ OUTUBRO"
  var MES_RE = new RegExp('(^|[^A-Z])(' + MESES.join('|') + '|' + ABREV.join('|') + ')(?![A-Z])'
    + '\\.?(?:(?:\\s*(?:\\/|-|DE)\\s*|\\s*)(\\d{4}|\\d{2}(?![\\d\\/])))?', 'g');
  var NAO_PAGAMENTO = /CONTA VINCULADA|REPACTUA|CORRECAO|FERIAS|13\s*[ºO°]?\s*SAL|RESCIS|ATESTO EXCEPCIONAL/;

  // ── utilidades ──
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/\s+/g, ' ').trim();
  }
  function soDigitos(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function vazio(v) { return !String(v == null ? '' : v).trim(); }
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

  // ── ler as folhas do bloco ──
  function lerBloco(doc) {
    var t = doc.querySelector('table.infraTable');
    if (!t || !t.rows.length) return null;
    var cab = Array.prototype.map.call(t.rows[0].cells, function (c) { return norm(c.textContent); });
    function col(re) { for (var i = 0; i < cab.length; i++) if (re.test(cab[i])) return i; return -1; }
    var iProc = col(/^PROCESSO/), iDoc = col(/^DOCUMENTO/), iTipo = col(/^TIPO/),
        iAss = col(/^ASSINATURA/), iAnot = col(/^ANOTA/);
    if (iDoc < 0 || iTipo < 0) return null;
    var out = [];
    for (var r = 1; r < t.rows.length; r++) {
      var c = t.rows[r].cells;
      if (!c[iDoc]) continue;
      var anot = iAnot >= 0 ? c[iAnot].innerText || c[iAnot].textContent : '';
      out.push({
        doc: c[iDoc].textContent.trim(),
        tipo: c[iTipo].textContent.trim(),
        processo: iProc >= 0 ? c[iProc].textContent.trim() : '',
        assinaturas: iAss >= 0 ? Array.prototype.map.call(c[iAss].querySelectorAll('.divRotuloItemCelula'),
          function (x) { return x.textContent.trim(); }) : [],
        anotacao: String(anot || '').replace(/\r/g, '').trim()
      });
    }
    return out;
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
  function contratosDoProcesso(dados, campo, processo) {
    var alvo = soDigitos(processo);
    if (alvo.length < 15) return [];
    var achou = {};
    dados.forEach(function (d) {
      var v = String(d[campo] || '');
      var tem = v.split(/[^\d.\/-]+/).some(function (p) { return soDigitos(p) === alvo; });
      if (tem && d.CONTRATO) achou[contratoNorm(d.CONTRATO) || String(d.CONTRATO).trim()] = 1;
    });
    return Object.keys(achou);
  }

  // meses citados em uma linha da anotação: [{m: 0..11, ano: 2026|null}]
  function mesesDaLinha(linhaNorm) {
    var out = [], m;
    MES_RE.lastIndex = 0;
    while ((m = MES_RE.exec(linhaNorm))) {
      var nome = m[2];
      var idx = MESES.indexOf(nome); if (idx < 0) idx = ABREV.indexOf(nome);
      var ano = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : null;
      out.push({m: idx, ano: ano});
    }
    // "Setembro/ Outubro 2026": mês sem ano herda o do próximo que tem
    for (var i = out.length - 2; i >= 0; i--) if (!out[i].ano && out[i + 1].ano) out[i].ano = out[i + 1].ano;
    return out;
  }
  function anoPadrao(m) {
    var hoje = new Date();
    return m <= hoje.getMonth() ? hoje.getFullYear() : hoje.getFullYear() - 1;
  }

  // ── decide as linhas de Documentos de uma folha ──
  function planejar(f, sis) {
    var r = {doc: f.doc, processo: f.processo, anotacao: f.anotacao.split('\n')[0], linhas: []};
    var jaTem = sis.lista.filter(function (o) { return numerosDoc(o.folhaInfo).indexOf(f.doc) >= 0; });
    if (jaTem.length) {
      r.status = 'ja';
      r.contrato = jaTem[0].contrato;
      r.detalhe = jaTem.map(function (o) { return o.mes + '/' + o.ano + ' ' + o.unidade; }).join(', ');
      return r;
    }
    var linhasAnot = f.anotacao.split('\n').map(norm).filter(Boolean);
    var primeira = linhasAnot[0] || '';
    if (NAO_PAGAMENTO.test(primeira)) {
      r.status = 'pula'; r.detalhe = 'anotação não é de pagamento mensal'; return r;
    }

    // contrato
    var porProc = contratosDoProcesso(sis.dados, 'PROCESSO PAGAMENTO', f.processo);
    var porCv = contratosDoProcesso(sis.dados, 'PROCESSO CONTA VINCULADA', f.processo);
    var porAnot = contratoNorm(primeira);
    var contrato = '';
    if (porProc.length === 1) contrato = porProc[0];
    else if (porAnot && (!porProc.length || porProc.indexOf(porAnot) >= 0)) contrato = porAnot;
    if (!contrato && porCv.length && !porProc.length) {
      r.status = 'pula'; r.detalhe = 'processo de conta vinculada (' + porCv.join(', ') + ')'; return r;
    }
    if (!contrato) {
      r.status = 'pend';
      r.detalhe = porProc.length > 1 ? 'processo é de mais de um contrato (' + porProc.join(', ') + ') e a anotação não decide'
        : 'contrato não identificado (processo fora de /dados e anotação sem nº do contrato)';
      return r;
    }
    r.contrato = contrato;
    if (porAnot && porAnot !== contrato) r.aviso = 'anotação diz ' + porAnot + ', processo é do ' + contrato;

    var doContrato = sis.lista.filter(function (o) { return contratoNorm(o.contrato) === contrato; });
    if (!doContrato.length) { r.status = 'pend'; r.detalhe = 'contrato ' + contrato + ' sem linhas na tela Documentos'; return r; }
    var unidades = {};
    doContrato.forEach(function (o) { var u = norm(o.unidade); if (u) unidades[u] = 1; });
    unidades = Object.keys(unidades);

    // texto da anotação sem o nº do contrato (senão o "/2026" dele vira ano)
    var alvos = [];   // {m, ano, unidades:[]|null}
    linhasAnot.forEach(function (ln, n) {
      var limpa = n === 0 ? ln.replace(/(\d{1,3})\s*\/\s*(\d{4}|\d{2})(?!\d)/, ' ') : ln;
      if (n > 0 && /^\D*,?\s*\d{1,2}\/\d{1,2}\/\d{2,4}\.?$/.test(ln)) return;   // "Mayara, 19/11/26."
      var ms = mesesDaLinha(limpa);
      if (!ms.length) return;
      var us = unidades.filter(function (u) {
        return u.length >= 2 && new RegExp('(^|[^A-Z0-9])' + u.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '([^A-Z0-9]|$)').test(limpa);
      });
      ms.forEach(function (x) { alvos.push({m: x.m, ano: x.ano || anoPadrao(x.m), unidades: us.length ? us : null}); });
    });

    var candidatas;
    if (alvos.length) {
      candidatas = doContrato.filter(function (o) {
        var mes = norm(o.mes), u = norm(o.unidade);
        return alvos.some(function (a) {
          return mes === MESES[a.m] && String(o.ano) === String(a.ano) && (!a.unidades || a.unidades.indexOf(u) >= 0);
        });
      });
      r.meses = alvos.map(function (a) { return MESES[a.m] + '/' + a.ano + (a.unidades ? ' (' + a.unidades.join(', ') + ')' : ''); })
        .filter(function (x, i, arr) { return arr.indexOf(x) === i; }).join(', ');
      var semLinha = alvos.filter(function (a) {
        return !candidatas.some(function (o) { return norm(o.mes) === MESES[a.m] && String(o.ano) === String(a.ano); });
      }).map(function (a) { return MESES[a.m] + '/' + a.ano; })
        .filter(function (x, i, arr) { return arr.indexOf(x) === i; });
      if (semLinha.length && semLinha.length < alvos.length) r.aviso = 'sem linha de ' + semLinha.join(', ') + ' na tela Documentos';
    } else {
      // sem mês na anotação: único mês com NF lançada e sem folha
      if (!porProc.length) {
        r.status = 'pend'; r.detalhe = 'anotação sem mês e processo não é o de pagamento do contrato'; return r;
      }
      var grupos = {};
      doContrato.forEach(function (o) {
        if (!vazio(o.folhaInfo) || !vazio(o.semPrestacao) || !vazio(o.envioPr3) || vazio(o.notaFiscal)) return;
        var k = norm(o.mes) + '/' + o.ano;
        (grupos[k] = grupos[k] || []).push(o);
      });
      var ks = Object.keys(grupos);
      if (ks.length !== 1) {
        r.status = 'pend';
        r.detalhe = ks.length ? 'anotação sem mês e há ' + ks.length + ' meses com NF sem folha (' + ks.join(', ') + ')'
          : 'anotação sem mês e nenhum mês com NF lançada aguardando folha';
        return r;
      }
      r.meses = ks[0] + ' (único mês com NF sem folha)';
      candidatas = grupos[ks[0]];
    }

    if (!candidatas.length) { r.status = 'pend'; r.detalhe = 'sem linha de ' + r.meses + ' na tela Documentos'; return r; }
    var livres = candidatas.filter(function (o) { return vazio(o.folhaInfo) && vazio(o.semPrestacao); });
    // a folha cobre as NFs do mês: se só parte das unidades já tem NF lançada,
    // as que estão sem NF ficam de fora (a NF delas virá em outra folha)
    var comNf = livres.filter(function (o) { return !vazio(o.notaFiscal); });
    if (comNf.length && comNf.length < livres.length) {
      r.aviso = (r.aviso ? r.aviso + '; ' : '') + (livres.length - comNf.length) + ' linha(s) sem NF lançada ficaram de fora';
      livres = comNf;
    }
    var outras = candidatas.filter(function (o) { return !vazio(o.folhaInfo); })
      .map(function (o) { return o.folhaInfo; }).filter(function (x, i, arr) { return arr.indexOf(x) === i; });
    if (!livres.length) {
      r.status = 'pend';
      r.detalhe = outras.length ? r.meses + ' já tem outra folha (' + outras.join(', ') + ') — não sobrescrevo'
        : 'linhas de ' + r.meses + ' marcadas como sem prestação';
      return r;
    }
    r.status = 'ok';
    r.linhas = livres.map(function (o) { return o.id; });
    r.detalhe = livres.map(function (o) { return o.mes + '/' + o.ano + ' ' + o.unidade; }).join(', ');
    if (outras.length) r.aviso = (r.aviso ? r.aviso + '; ' : '') + 'outras linhas do mesmo mês já têm a folha ' + outras.join(', ');
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
  }

  try {
    window.__pr6Bloco743Simular = function () {
      return sincronizar({simular: true}).then(function (r) {
        if (console.table) console.table(r.planos.map(function (p) {
          return {doc: p.doc, status: p.status, contrato: p.contrato || '', meses: p.meses || '', detalhe: p.detalhe || '', aviso: p.aviso || ''};
        }));
        return r;
      });
    };
  } catch (e) {}

  // ── painel na página do bloco ──
  var ROTULO = {ok: ['✔ Lançada', '#1b7a3a', '#e9f6ee'], ja: ['• Já estava no sistema', '#456', '#f1f4f8'],
                pula: ['— Ignorada', '#777', '#f6f6f6'], pend: ['⚠ Não lançada', '#a35a00', '#fff4e5']};
  function painel(res, erro) {
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
      html += '<div style="color:#567">Conferindo com a tela Documentos…</div>';
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
          + '<td style="padding:3px 6px">' + esc(p.detalhe || '') + (p.aviso ? '<div style="color:#a35a00">' + esc(p.aviso) + '</div>' : '') + '</td>'
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
    sincronizar().then(function (res) {
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

  if (document.readyState === 'complete') setTimeout(iniciar, 500);
  else window.addEventListener('load', function () { setTimeout(iniciar, 500); });
})();
