// ==UserScript==
// @name         Contratos.gov — preencher o Instrumento de Cobrança
// @namespace    https://fiscalizacaopr6.github.io/
// @version      1.1.0
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
 *   5. em cada linha da grade, preenche Valor unitário e Quantidade conforme a
 *      tela de IC. O casamento é SEMPRE pelo "Número compra: 000NN" da descrição
 *      (= número do item do contrato). As linhas do Contratos.gov vêm fora de
 *      ordem — 16, 28, 29, 30, 31, 25… —, então nada é preenchido por posição:
 *      linha sem número reconhecido fica vazia e é avisada no painel.
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

  var VERSAO = '1.1.0';
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

  // ─────────── linhas dos itens ───────────
  // A grade do Contratos.gov não é <table>: cada item é um
  //   div.repeatable-element[data-repeatable-identifier="contratofaturasitem"]
  // com input.valorunitario_faturado e input.quantidade_faturado dentro.
  // O número do item do contrato NÃO é o código do catálogo (23647…) nem a
  // posição da linha — as linhas vêm fora de ordem. Ele aparece na descrição
  // como "Número compra: 00016".
  var SEL_VAL = 'input.valorunitario_faturado, input[name*="valorunitario_faturado"]';
  var SEL_QTD = 'input.quantidade_faturado, input[name*="quantidade_faturado"]';

  function linhasItens() {
    var vals = document.querySelectorAll(SEL_VAL);
    var linhas = [];
    for (var i = 0; i < vals.length; i++) {
      var inpVal = vals[i];
      var caixa = inpVal.closest ? inpVal.closest('[data-repeatable-identifier]') : null;
      var inpQtd = caixa ? caixa.querySelector(SEL_QTD) : null;
      if (!inpQtd) {                       // sem o marcador: subo até o bloco que tem SÓ este item
        var p = inpVal;
        for (var n = 0; n < 8 && p.parentElement; n++) {
          p = p.parentElement;
          if (p.querySelectorAll(SEL_VAL).length !== 1) { p = null; break; }
          var q = p.querySelector(SEL_QTD);
          if (q) { inpQtd = q; caixa = p; break; }
        }
      }
      if (!inpQtd || !caixa) continue;
      var desc = caixa.querySelector('.descricao_item');
      var txt = texto(desc) || texto(caixa);
      var m = txt.match(/n[úu]mero\s*compra:?\s*0*(\d+)/i);
      linhas.push({
        num: m ? parseInt(m[1], 10) : null,
        rotulo: (m ? 'item ' + m[1] : 'linha ' + (caixa.getAttribute('data-row-number') || (i + 1))),
        inpVal: inpVal, inpQtd: inpQtd
      });
    }
    return linhas.length ? linhas : null;
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

  // Casa SEMPRE pelo número do item. Não existe encaixe por ordem: as linhas do
  // Contratos.gov vêm embaralhadas (16, 28, 29, 30, 31, 25…), então preencher
  // pela posição colocaria o valor de um item na linha de outro.
  function preencherItens(dados, linhas) {
    var porNumero = {};
    dados.itens.forEach(function (i) {
      var n = numeroDe(String(i.item));
      if (n != null) porNumero[n] = i;
    });
    var feitos = 0, semCasar = [], usados = {};
    linhas.forEach(function (l) {
      var dado = (l.num != null) ? porNumero[l.num] : null;
      if (!dado) { semCasar.push(l.rotulo); return; }
      var okV = preencher(l.inpVal, BR.format(dado.valor));   // 6.064,15 — conferido na tela real
      var okQ = preencher(l.inpQtd, String(dado.qtde));
      if (okV && okQ) { feitos++; usados[l.num] = true; } else semCasar.push(l.rotulo);
    });
    var semLinha = Object.keys(porNumero).filter(function (n) { return !usados[n]; });
    return { feitos: feitos, falhas: semCasar, semLinha: semLinha };
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
        return esperar(function () { return linhasItens(); });
      })
      .then(function (linhas) {
        var r = preencherItens(dados, linhas);
        if (r.feitos) passo(r.feitos + ' de ' + linhas.length + ' linha(s) preenchida(s)', 'ok');
        if (r.falhas.length) passo('Linhas sem valor: ' + r.falhas.join(', '), 'erro');
        if (r.semLinha.length) passo('Itens do IC sem linha na tela: ' + r.semLinha.join(', '), 'erro');
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
        linhas: (function () {
          var l = linhasItens();
          return l ? l.map(function (x) { return { num: x.num, rotulo: x.rotulo }; }) : null;
        })()
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
