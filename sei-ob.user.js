// ==UserScript==
// @name         SEI UFRJ — pesquisa automática da Ordem Bancária
// @namespace    https://fiscalizacaopr6.github.io/
// @version      1.0.0
// @description  Recebe o número da ordem bancária vindo do Controle de Faturamento (sei.ufrj.br/sei/#ob=NUMERO), preenche a Pesquisa do SEI e envia sozinho. Sobrevive ao login quando a sessão está expirada.
// @author       Fiscalização PR6 / UFRJ
// @match        https://sei.ufrj.br/sei/*
// @match        https://sei.ufrj.br/sip/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/sei-ob.user.js
// @updateURL    https://fiscalizacaopr6.github.io/Sistema-Controle-de-Faturamento/sei-ob.user.js
// ==/UserScript==

/*
 * Por que este script existe:
 * o SEI 4 exige um "infra_hash" assinado pelo servidor em toda URL da área
 * autenticada — link externo apontando para a busca é recusado com
 * "Link sem assinatura". A saída é preencher a Pesquisa por dentro da própria
 * página do SEI: o formulário dele já carrega o hash válido.
 *
 * Fluxo: o sistema abre https://sei.ufrj.br/sei/#ob=6237243
 *   1. o script guarda o número (vale por 10 min) e limpa o #
 *   2. se caiu na tela de login, espera — o número fica guardado
 *   3. achando o campo de pesquisa, preenche e envia
 *   4. se não achar o campo, mostra um aviso com botão de copiar
 */

(function () {
  'use strict';

  var CHAVE = 'pr6_sei_ob_pendente';
  var VALIDADE_MS = 10 * 60 * 1000;   // número guardado vale 10 minutos
  var ESPERA_MS   = 15 * 1000;        // tempo procurando o campo de pesquisa

  // ── número pendente (localStorage: sobrevive ao login e vale entre frames) ──
  function guardar(num) {
    try { localStorage.setItem(CHAVE, JSON.stringify({ n: num, t: Date.now() })); } catch (e) {}
  }

  function pendente() {
    try {
      var o = JSON.parse(localStorage.getItem(CHAVE) || 'null');
      if (!o || !o.n) return null;
      if (Date.now() - o.t > VALIDADE_MS) { limpar(); return null; }
      return String(o.n);
    } catch (e) { return null; }
  }

  function limpar() {
    try { localStorage.removeItem(CHAVE); } catch (e) {}
  }

  // ── captura o número da URL: .../sei/#ob=6237243 ──
  var m = String(location.hash || '').match(/ob=([^&]+)/);
  if (m) {
    guardar(decodeURIComponent(m[1]));
    // tira o # da barra de endereços para um F5 não repetir a busca
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  var num = pendente();
  if (!num) return;

  // na tela de login não há o que fazer: o número fica guardado para depois
  if (/\/sip\/login\.php/i.test(location.pathname + location.search)) return;

  // ── acha o campo de Pesquisa do SEI ──
  function campo() {
    return document.getElementById('txtPesquisaRapida')
      || document.querySelector('input[name="txtPesquisaRapida"]')
      || document.querySelector('#frmProtocoloPesquisaRapida input[type="text"]')
      || document.querySelector('form[action*="protocolo_pesquisa_rapida"] input[type="text"]');
  }

  function pesquisar(inp) {
    limpar();                       // limpa ANTES de enviar: nunca entra em laço
    inp.value = num;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    var form = inp.form;
    var botao = form && (form.querySelector('#sbmPesquisaRapida')
      || form.querySelector('button[type="submit"], input[type="submit"], input[type="image"]'));
    // o formulário do SEI já traz o infra_hash válido na própria action
    if (botao) botao.click();
    else if (form) form.submit();
    else {
      inp.focus();
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  // ── aviso quando o campo não aparece (layout diferente, tela de erro etc.) ──
  function avisar() {
    if (document.getElementById('pr6-ob-aviso')) return;
    var cx = document.createElement('div');
    cx.id = 'pr6-ob-aviso';
    cx.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#fff;'
      + 'border:1px solid #c3d4e6;border-left:4px solid #0a6ca8;border-radius:6px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.25);padding:12px 14px;font:13px Arial,sans-serif;color:#123';
    cx.innerHTML = '<div style="margin-bottom:8px">Ordem bancária <b style="font-size:15px">'
      + num.replace(/[<>&"]/g, '') + '</b><br><span style="color:#567">Pesquise por este número no SEI.</span></div>'
      + '<button id="pr6-ob-copiar" style="cursor:pointer;border:1px solid #0a6ca8;background:#0a6ca8;color:#fff;'
      + 'border-radius:4px;padding:5px 10px;font:600 12px Arial,sans-serif">Copiar número</button> '
      + '<button id="pr6-ob-fechar" style="cursor:pointer;border:1px solid #c3d4e6;background:#fff;color:#456;'
      + 'border-radius:4px;padding:5px 10px;font:600 12px Arial,sans-serif">Fechar</button>';
    document.body.appendChild(cx);
    document.getElementById('pr6-ob-copiar').onclick = function () {
      try { navigator.clipboard.writeText(num); this.textContent = 'Copiado ✔'; } catch (e) {}
    };
    document.getElementById('pr6-ob-fechar').onclick = function () {
      limpar();
      cx.parentNode.removeChild(cx);
    };
  }

  // ── procura o campo até achar (o SEI monta a barra depois do load) ──
  var inicio = Date.now();
  (function tentar() {
    if (!pendente()) return;              // outro frame já resolveu
    var inp = campo();
    if (inp) { pesquisar(inp); return; }
    if (Date.now() - inicio > ESPERA_MS) {
      // só o frame de cima mostra o aviso, para não duplicar
      if (window.top === window.self) avisar();
      return;
    }
    setTimeout(tentar, 300);
  })();
})();
