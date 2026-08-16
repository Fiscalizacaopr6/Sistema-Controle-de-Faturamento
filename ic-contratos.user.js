// ==UserScript==
// @name         Contratos.gov — preencher o Instrumento de Cobrança
// @namespace    https://fiscalizacaopr6.github.io/
// @version      1.0.0
// @description  Recebe os itens vindos da tela de IC do Controle de Faturamento (…/instrumento-cobranca/create#ic=…) e preenche sozinho: aba "Itens Instrumento Cobrança", primeiro termo do histórico, "Todos" nos itens e, em cada item, o valor unitário e a quantidade.
// @author       Fiscalização PR6 / UFRJ
// @match        https://contratos.sistema.gov.br/*
// @match        https://contratos.comprasnet.gov.br/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/ic-contratos.user.js
// @updateURL    https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/ic-contratos.user.js
// ==/UserScript==

/*
 * Por que este script existe:
 * o botão "FAZER IC" do Controle de Faturamento abre
 *   https://contratos.sistema.gov.br/meus-contratos/<ID>/instrumento-cobranca/create#ic=<dados>
 * mas o dashboard está em outro domínio — não pode tocar naquela página. Quem
 * preenche é este script, rodando dentro do próprio Contratos.gov.
 *
 * O que ele faz, na ordem:
 *   1. guarda o "#ic=" (vale 30 min, sobrevive a login/recarregamento) e limpa a URL
 *   2. abre a aba "Itens Instrumento Cobrança"
 *   3. em "Histórico do contrato" escolhe SEMPRE o primeiro registro da lista
 *   4. em "Itens do histórico" escolhe "Todos"
 *   5. em cada linha da tabela, preenche Valor unitário e Quantidade conforme a
 *      tela de IC (casa pelo número do item; se não casar, avisa)
 *
 * Ele NUNCA clica em "Criar Instrumento de Cobrança" — a conferência e o envio
 * continuam sendo seus.
 *
 * Diagnóstico, no console (F12) da página do Contratos.gov:
 *   window.__pr6IcScript  → versão instalada
 *   window.__pr6IcDados() → os valores que vieram do dashboard
 *   window.__pr6IcDiag()  → o que o script enxerga na tela (abas, campos, tabela)
 *   window.__pr6IcRodar() → repete o preenchimento
 */

(function () {
  'use strict';

  var VERSAO = '1.0.0';
  try { window.__pr6IcScript = VERSAO; } catch (e) {}

  var CHAVE       = 'pr6_ic_pendente';
  var VALIDADE_MS = 30 * 60 * 1000;   // dados do dashboard valem 30 minutos
  var ESPERA_MS   = 20 * 1000;        // tempo máximo esperando cada pedaço da tela
  var rodando     = false;

  // ─────────── utilidades ───────────
  function norm(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\*$/, '').trim();
  }
  function texto(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function textoProprio(el) {   // só os textos filhos diretos — evita casar com o container inteiro
    if (!el) return '';
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    }
    return s.replace(/\s+/g, ' ').trim();
  }
  function visivel(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function esperar(fn, limite) {
    return new Promise(function (ok, erro) {
      var t0 = Date.now();
      (function tentar() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return ok(v);
        if (Date.now() - t0 > (limite || ESPERA_MS)) return erro(new Error('não apareceu a tempo'));
        setTimeout(tentar, 200);
      })();
    });
  }
  function pausa(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function clicar(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (tipo) {
      el.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
    });
  }
  var BR = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ─────────── dados vindos do dashboard ───────────
  function lerHash() {
    var m = (location.hash || '').match(/[#&]ic=([^&]+)/);
    if (!m) return null;
    try {
      var json = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
      var o = JSON.parse(json);
      return (o && o.itens && o.itens.length) ? o : null;
    } catch (e) { return null; }
  }
  function guardar(o) {
    try { sessionStorage.setItem(CHAVE, JSON.stringify({ t: Date.now(), d: o })); } catch (e) {}
  }
  function pendente() {
    try {
      var o = JSON.parse(sessionStorage.getItem(CHAVE) || 'null');
      if (!o || !o.d) return null;
      if (Date.now() - o.t > VALIDADE_MS) { sessionStorage.removeItem(CHAVE); return null; }
      return o.d;
    } catch (e) { return null; }
  }
  try { window.__pr6IcDados = pendente; } catch (e) {}

  // ─────────── painel de acompanhamento ───────────
  var painel = null, passos = null;
  function abrirPainel(dados) {
    if (painel) return;
    painel = document.createElement('div');
    painel.id = 'pr6-ic-painel';
    painel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:340px;background:#fff;'
      + 'border:1px solid #c3d4e6;border-left:4px solid #0a6ca8;border-radius:6px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.25);padding:12px 14px;font:13px Arial,sans-serif;color:#123';
    painel.innerHTML = '<div style="font-weight:700;margin-bottom:2px">Instrumento de Cobrança</div>'
      + '<div style="color:#567;font-size:12px;margin-bottom:8px">Contrato ' + esc(dados.contrato || '—')
      + ' · ' + esc(dados.mes || '—') + '</div>'
      + '<div id="pr6-ic-passos" style="font-size:12px;line-height:1.7"></div>'
      + '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">'
      + '<button id="pr6-ic-valores" style="cursor:pointer;border:1px solid #0a6ca8;background:#fff;color:#0a6ca8;border-radius:4px;padding:5px 10px;font:600 12px Arial,sans-serif">Ver valores</button>'
      + '<button id="pr6-ic-fechar" style="cursor:pointer;border:1px solid #c3d4e6;background:#fff;color:#456;border-radius:4px;padding:5px 10px;font:600 12px Arial,sans-serif">Fechar</button>'
      + '</div><div id="pr6-ic-tabela"></div>';
    document.body.appendChild(painel);
    passos = painel.querySelector('#pr6-ic-passos');
    painel.querySelector('#pr6-ic-fechar').onclick = function () {
      painel.parentNode.removeChild(painel); painel = null; passos = null;
    };
    painel.querySelector('#pr6-ic-valores').onclick = function () { mostrarValores(dados); };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, ''); }
  function passo(txt, estado) {
    if (!passos) return;
    var cor = estado === 'ok' ? '#1a7f37' : (estado === 'erro' ? '#b42318' : '#567');
    var sinal = estado === 'ok' ? '✔' : (estado === 'erro' ? '✕' : '…');
    var linha = document.createElement('div');
    linha.style.color = cor;
    linha.textContent = sinal + ' ' + txt;
    passos.appendChild(linha);
  }
  function mostrarValores(dados) {
    var alvo = painel && painel.querySelector('#pr6-ic-tabela');
    if (!alvo) return;
    if (alvo.innerHTML) { alvo.innerHTML = ''; return; }
    var linhas = dados.itens.map(function (i) {
      return '<tr><td style="padding:2px 8px 2px 0">' + esc(i.item) + '</td>'
        + '<td style="padding:2px 8px 2px 0;text-align:right">' + BR.format(i.valor) + '</td>'
        + '<td style="padding:2px 0;text-align:right">' + i.qtde + '</td></tr>';
    }).join('');
    alvo.innerHTML = '<table style="margin-top:8px;font:12px Arial,sans-serif;border-top:1px solid #dde">'
      + '<tr style="color:#567"><td style="padding:4px 8px 4px 0">Item</td>'
      + '<td style="padding:4px 8px 4px 0;text-align:right">Vlr. unit.</td>'
      + '<td style="padding:4px 0;text-align:right">Qtde</td></tr>' + linhas + '</table>';
  }

  // ─────────── achar coisas na tela ───────────
  var SEL_DROPDOWN = 'select, .p-dropdown, .p-multiselect, .ng-select, ng-select, [role="combobox"],'
    + ' .dropdown-toggle, .select2-container, .mat-select, .br-select';
  var SEL_PAINEL = '.p-dropdown-panel, .p-multiselect-panel, .ng-dropdown-panel, .dropdown-menu,'
    + ' [role="listbox"], .cdk-overlay-pane, .select2-results, .mat-select-panel';
  var SEL_OPCAO = '[role="option"], .p-dropdown-item, .p-multiselect-item, .ng-option, .dropdown-item,'
    + ' .select2-results__option, .mat-option, li';

  function abaPorTexto(rot) {
    var alvo = norm(rot), achado = null;
    var cand = document.querySelectorAll('a, button, li, span, div[role="tab"], [role="tab"]');
    for (var i = 0; i < cand.length; i++) {
      if (!visivel(cand[i])) continue;
      if (norm(texto(cand[i])) === alvo) achado = cand[i];   // fica com o mais interno
    }
    return achado;
  }

  function campoPorRotulo(rot) {
    var alvo = norm(rot);
    var cand = document.querySelectorAll('label, span, div, p, legend');
    for (var i = 0; i < cand.length; i++) {
      if (norm(textoProprio(cand[i])) !== alvo) continue;
      var p = cand[i];
      for (var n = 0; n < 5 && p; n++, p = p.parentElement) {
        var dd = p.querySelector(SEL_DROPDOWN);
        if (dd && visivel(dd)) return dd;
      }
    }
    return null;
  }

  function opcoesAbertas() {
    var lista = [];
    var paineis = document.querySelectorAll(SEL_PAINEL);
    for (var i = 0; i < paineis.length; i++) {
      if (!visivel(paineis[i])) continue;
      var ops = paineis[i].querySelectorAll(SEL_OPCAO);
      for (var j = 0; j < ops.length; j++) {
        if (visivel(ops[j]) && texto(ops[j])) lista.push(ops[j]);
      }
    }
    // descarta os que só embrulham outra opção (li > li)
    return lista.filter(function (o) {
      return !lista.some(function (x) { return x !== o && o.contains(x); });
    });
  }

  // Abre o dropdown e escolhe: escolher(textos) devolve o índice desejado.
  function escolherNoDropdown(dd, escolher) {
    if (dd.tagName === 'SELECT') {
      // descarta o "Selecionar registro" (option sem value)
      var opts = [].filter.call(dd.options, function (o) { return o.value; });
      var idx = escolher(opts.map(texto));
      if (idx < 0 || !opts[idx]) return Promise.reject(new Error('opção não encontrada'));
      var alvo = opts[idx];
      dd.value = alvo.value;
      dd.dispatchEvent(new Event('input', { bubbles: true }));
      dd.dispatchEvent(new Event('change', { bubbles: true }));
      return Promise.resolve(texto(alvo));
    }
    clicar(dd);
    return esperar(function () {
      var l = opcoesAbertas();
      return l.length ? l : null;
    }).then(function (lista) {
      var idx = escolher(lista.map(texto));
      if (idx < 0) throw new Error('opção não encontrada');
      var t = texto(lista[idx]);
      clicar(lista[idx]);
      return t;
    });
  }

  // ─────────── tabela dos itens ───────────
  function tabelaItens() {
    var tabelas = document.querySelectorAll('table');
    for (var i = 0; i < tabelas.length; i++) {
      var ths = tabelas[i].querySelectorAll('th');
      var cab = [].map.call(ths, function (th) { return norm(texto(th)); });
      var iVal = cab.findIndex(function (t) { return t.indexOf('valor unitario') === 0; });
      var iQtd = cab.findIndex(function (t) { return t.indexOf('quantidade') === 0; });
      if (iVal < 0 || iQtd < 0) continue;
      var linhas = [].filter.call(tabelas[i].querySelectorAll('tbody tr'), function (tr) {
        return tr.querySelector('input');
      });
      if (!linhas.length) continue;
      return {
        iItem: cab.findIndex(function (t) { return t.indexOf('item') === 0; }),
        iVal: iVal, iQtd: iQtd, linhas: linhas
      };
    }
    return null;
  }

  // Preenche respeitando máscara: escreve pelo setter nativo, avisa o framework
  // e confere; se o valor não ficar, digita caractere a caractere.
  function preencher(inp, valor) {
    if (!inp) return false;
    escrever(inp, valor);
    if (inp.value && inp.value.replace(/\s/g, '') !== '') return true;
    digitar(inp, valor);
    return !!inp.value;
  }
  function escrever(inp, valor) {
    var proto = inp instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    inp.focus();
    setter.call(inp, '');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inp, valor);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function digitar(inp, valor) {
    inp.focus();
    var proto = HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(inp, '');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    for (var i = 0; i < valor.length; i++) {
      var c = valor[i];
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true }));
      setter.call(inp, inp.value + c);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: c, bubbles: true }));
    }
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function numeroDe(txt) {
    var m = (txt || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function preencherItens(dados, tab) {
    var porNumero = {};
    dados.itens.forEach(function (i) {
      var n = numeroDe(String(i.item));
      if (n != null) porNumero[n] = i;
    });
    var feitos = 0, semCasar = [];
    tab.linhas.forEach(function (tr, pos) {
      var cels = tr.cells;
      var rotulo = tab.iItem >= 0 && cels[tab.iItem] ? texto(cels[tab.iItem]) : '';
      var n = numeroDe(rotulo);
      var dado = (n != null && porNumero[n]) ? porNumero[n]
        : (tab.linhas.length === dados.itens.length ? dados.itens[pos] : null);   // mesma quantidade de linhas: casa pela ordem
      if (!dado) { semCasar.push(rotulo || ('linha ' + (pos + 1))); return; }
      var inpVal = cels[tab.iVal] && cels[tab.iVal].querySelector('input');
      var inpQtd = cels[tab.iQtd] && cels[tab.iQtd].querySelector('input');
      var okV = preencher(inpVal, BR.format(dado.valor));
      var okQ = preencher(inpQtd, String(dado.qtde));
      if (okV && okQ) feitos++; else semCasar.push(rotulo || ('linha ' + (pos + 1)));
    });
    return { feitos: feitos, falhas: semCasar };
  }

  // ─────────── roteiro ───────────
  function rodar() {
    var dados = pendente();
    if (!dados || rodando) return;
    if (!/instrumento-cobranca\/(create|criar)/i.test(location.pathname)) return;
    rodando = true;
    abrirPainel(dados);

    esperar(function () { return abaPorTexto('Itens Instrumento Cobrança'); })
      .then(function (aba) {
        clicar(aba);
        passo('Aba "Itens Instrumento Cobrança"', 'ok');
        return esperar(function () { return campoPorRotulo('Histórico do contrato'); });
      })
      .then(function (dd) {
        return escolherNoDropdown(dd, function () { return 0; });   // sempre o primeiro registro
      })
      .then(function (escolhido) {
        passo('Histórico: ' + escolhido, 'ok');
        return pausa(600).then(function () {
          return esperar(function () { return campoPorRotulo('Itens do histórico'); });
        });
      })
      .then(function (dd) {
        return escolherNoDropdown(dd, function (textos) {
          var i = textos.findIndex(function (t) { return norm(t) === 'todos'; });
          return i >= 0 ? i : 0;
        });
      })
      .then(function (escolhido) {
        passo('Itens do histórico: ' + escolhido, 'ok');
        return esperar(function () { return tabelaItens(); });
      })
      .then(function (tab) {
        var r = preencherItens(dados, tab);
        if (r.feitos) passo(r.feitos + ' item(ns) preenchido(s)', 'ok');
        if (r.falhas.length) passo('Não preenchi: ' + r.falhas.join(', '), 'erro');
        passo('Confira e clique em "Criar Instrumento de Cobrança"', '');
        rodando = false;
      })
      .catch(function (e) {
        passo('Parei aqui: ' + (e && e.message || e), 'erro');
        passo('Preencha à mão — clique em "Ver valores"', '');
        rodando = false;
      });
  }
  try { window.__pr6IcRodar = function () { rodando = false; rodar(); }; } catch (e) {}

  // Diagnóstico: o que o script enxerga (para ajustar os seletores, se preciso)
  try {
    window.__pr6IcDiag = function () {
      var o = {
        versao: VERSAO,
        url: location.pathname + location.hash.slice(0, 20),
        dados: pendente(),
        aba: !!abaPorTexto('Itens Instrumento Cobrança'),
        historico: !!campoPorRotulo('Histórico do contrato'),
        itensHistorico: !!campoPorRotulo('Itens do histórico'),
        opcoesAbertas: opcoesAbertas().map(texto),
        tabela: (function () {
          var t = tabelaItens();
          return t ? { linhas: t.linhas.length, colValor: t.iVal, colQtde: t.iQtd, colItem: t.iItem } : null;
        })(),
        cabecalhos: [].map.call(document.querySelectorAll('th'), texto)
      };
      console.log(o);
      return o;
    };
  } catch (e) {}

  // ─────────── início ───────────
  function iniciar() {
    var novo = lerHash();
    if (novo) {
      guardar(novo);
      // tira o "#ic=" da barra sem recarregar (a página é uma SPA)
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
    rodar();
  }

  window.addEventListener('hashchange', function () { rodando = false; iniciar(); });
  // a SPA troca de rota sem recarregar: fico de olho no caminho
  var ultimo = location.pathname;
  setInterval(function () {
    if (location.pathname !== ultimo) { ultimo = location.pathname; rodando = false; rodar(); }
  }, 800);
  iniciar();
})();
