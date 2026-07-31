// ==UserScript==
// @name         SEI UFRJ — pesquisa automática da Ordem Bancária
// @namespace    https://fiscalizacaopr6.github.io/
// @version      1.2.0
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
 *   3. achando o campo de pesquisa, preenche, CONFERE se o valor ficou e envia
 *   4. se não achar o campo (ou o envio não sair do lugar), mostra um aviso
 *
 * Conferido no SEI da UFRJ: o campo é #txtPesquisaRapida, dentro do form
 * #frmProtocoloPesquisaRapida.
 *
 * Duas armadilhas que este arquivo trata (1.2.0), ambas de tempo — por isso o
 * mesmo código funcionava numa máquina e não em outra:
 *
 *   a) o SEI roda a inicialização dele no load e LIMPA os campos do formulário.
 *      Preenchendo cedo demais, o valor some e o envio sai vazio: a tela
 *      recarrega e nada abre. Agora esperamos o load, preenchemos e só enviamos
 *      depois de conferir que o valor continua no campo (repondo se sumir).
 *
 *   b) form.submit() NÃO dispara o onsubmit da página. Se o SEI prepara algo ali,
 *      o POST chega incompleto e ele devolve a mesma tela. A ordem de envio agora
 *      é: requestSubmit() (equivale a um envio de verdade, roda o onsubmit) →
 *      clique no botão → submit() → Enter no campo.
 *
 * Diagnóstico: no console (F12) de uma página do SEI,
 *   window.__pr6ObScript  → versão instalada
 *   window.__pr6ObLog()   → o que o script fez nas últimas páginas
 */

(function () {
  'use strict';

  var VERSAO = '1.2.0';

  // marca de que o script está rodando — para conferir a instalação, digite
  // window.__pr6ObScript no console (F12) de uma página do SEI
  try { window.__pr6ObScript = VERSAO; } catch (e) {}

  var CHAVE     = 'pr6_sei_ob_pendente';
  var CHAVE_LOG = 'pr6_sei_ob_log';
  var VALIDADE_MS   = 10 * 60 * 1000;  // número guardado vale 10 minutos
  var ESPERA_MS     = 15 * 1000;       // tempo procurando o campo de pesquisa
  var ASSENTAR_MS   = 400;             // respiro após o load, antes de preencher
  var CONFERIR_MS   = 300;             // espera antes de conferir se o valor ficou
  var REPOSICOES    = 8;               // vezes que reponho o valor se o SEI limpar
  var ENVIO_MS      = 8 * 1000;        // se o envio não navegar nesse tempo, aviso

  var enviando  = false;               // trava contra envio duplicado no mesmo frame
  var procurando = false;              // trava contra dois laços de busca no mesmo frame

  // ── registro do que aconteceu (sobrevive à navegação, ajuda a diagnosticar) ──
  function log(evento, extra) {
    var linha = {
      t: new Date().toISOString().slice(11, 19),
      url: location.pathname + location.search,
      frame: window.top === window.self ? 'topo' : 'interno',
      ev: evento
    };
    if (extra !== undefined) linha.info = extra;
    try {
      var lista = JSON.parse(localStorage.getItem(CHAVE_LOG) || '[]');
      lista.push(linha);
      localStorage.setItem(CHAVE_LOG, JSON.stringify(lista.slice(-30)));
    } catch (e) {}
  }

  try {
    window.__pr6ObLog = function () {
      var lista = [];
      try { lista = JSON.parse(localStorage.getItem(CHAVE_LOG) || '[]'); } catch (e) {}
      if (console.table) console.table(lista);
      return lista;
    };
  } catch (e) {}

  // ── número pendente (localStorage: sobrevive ao login e vale entre frames) ──
  // fase: 'pendente' = ainda vou pesquisar | 'enviado' = já mandei, aguardo a navegação
  function guardar(num) {
    try {
      localStorage.setItem(CHAVE, JSON.stringify({ n: num, t: Date.now(), fase: 'pendente' }));
    } catch (e) {}
  }

  function estado() {
    try {
      var o = JSON.parse(localStorage.getItem(CHAVE) || 'null');
      if (!o || !o.n) return null;
      if (Date.now() - o.t > VALIDADE_MS) { limpar(); return null; }
      return o;
    } catch (e) { return null; }
  }

  function marcarEnviado(num) {
    try {
      localStorage.setItem(CHAVE, JSON.stringify({
        n: num, t: Date.now(), fase: 'enviado', tEnvio: Date.now()
      }));
    } catch (e) {}
  }

  function limpar() {
    try { localStorage.removeItem(CHAVE); } catch (e) {}
  }

  // ── acha o campo de Pesquisa do SEI ──
  function campo() {
    return document.getElementById('txtPesquisaRapida')
      || document.querySelector('input[name="txtPesquisaRapida"]')
      || document.querySelector('#frmProtocoloPesquisaRapida input[type="text"]')
      || document.querySelector('form[action*="protocolo_pesquisa_rapida"] input[type="text"]');
  }

  // ── preenche e só envia depois de confirmar que o valor ficou no campo ──
  // (o SEI limpa os campos ao terminar de inicializar; sem esta conferência o
  //  envio sai vazio, que é o "aparece o número e some" relatado)
  function preencher(inp, num, tentativa) {
    inp.focus();
    inp.value = num;
    inp.dispatchEvent(new Event('input',  { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(function () {
      if (inp.value !== num) {
        if (tentativa < REPOSICOES) {
          log('campo limpo pelo SEI, repondo', tentativa + 1);
          preencher(inp, num, tentativa + 1);
          return;
        }
        log('campo continua sendo limpo, desisto do envio automático');
        limpar();
        avisar(num);
        return;
      }
      enviar(inp, num);
    }, CONFERIR_MS);
  }

  function enviar(inp, num) {
    if (enviando) return;
    enviando = true;
    marcarEnviado(num);                 // não apago: se o envio não navegar, eu aviso

    var form = inp.form
      || document.getElementById('frmProtocoloPesquisaRapida')
      || document.querySelector('form[action*="protocolo_pesquisa_rapida"]');

    if (!form) {
      log('sem formulário, tentando Enter');
      inp.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      vigiarEnvio(num);
      return;
    }

    var botao = form.querySelector('#sbmPesquisaRapida')
      || form.querySelector('button[type="submit"], input[type="submit"], input[type="image"]');

    // requestSubmit primeiro: é o único que se comporta como envio de verdade,
    // disparando o onsubmit que o SEI usa para montar a requisição.
    // O form do SEI já traz o infra_hash válido na própria action.
    if (typeof form.requestSubmit === 'function') {
      try {
        log('enviando por requestSubmit', form.getAttribute('action') || '');
        form.requestSubmit(botao || undefined);
        vigiarEnvio(num);
        return;
      } catch (e) { log('requestSubmit falhou', String(e)); }
    }
    if (botao) {
      log('enviando por clique no botão');
      botao.click();
      vigiarEnvio(num);
      return;
    }
    log('enviando por form.submit');
    form.submit();
    vigiarEnvio(num);
  }

  // se em ENVIO_MS a página não saiu do lugar, o envio não pegou: aviso em vez
  // de deixar o usuário olhando para um campo vazio
  function vigiarEnvio(num) {
    setTimeout(function () {
      var e = estado();
      if (e && e.fase === 'enviado') {
        log('envio não navegou');
        limpar();
        if (window.top === window.self) avisar(num);
      }
    }, ENVIO_MS);
  }

  // ── aviso quando o campo não aparece (layout diferente, tela de erro etc.) ──
  function avisar(num) {
    if (!document.body || document.getElementById('pr6-ob-aviso')) return;
    var cx = document.createElement('div');
    cx.id = 'pr6-ob-aviso';
    cx.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#fff;'
      + 'border:1px solid #c3d4e6;border-left:4px solid #0a6ca8;border-radius:6px;'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.25);padding:12px 14px;font:13px Arial,sans-serif;color:#123';
    cx.innerHTML = '<div style="margin-bottom:8px">Ordem bancária <b style="font-size:15px">'
      + num.replace(/[<>&"]/g, '') + '</b><br><span style="color:#567">A pesquisa automática não '
      + 'saiu. Cole o número na Pesquisa do SEI e tecle Enter.</span></div>'
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

  // ── espera a página assentar: o SEI limpa os campos na inicialização dele ──
  // (chama fn uma vez só — pelo readyState OU pelo load, o que vier primeiro)
  function quandoAssentar(fn) {
    var chamou = false;
    function uma() {
      if (chamou) return;
      chamou = true;
      setTimeout(fn, ASSENTAR_MS);
    }
    if (document.readyState === 'complete') uma();
    window.addEventListener('load', uma);
  }

  function iniciar() {
    // captura o número da URL: .../sei/#ob=6237243
    var m = String(location.hash || '').match(/ob=([^&]+)/);
    if (m) {
      guardar(decodeURIComponent(m[1]));
      log('número recebido pela URL', decodeURIComponent(m[1]));
      // tira o # da barra de endereços para um F5 não repetir a busca
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }

    var e = estado();
    if (!e) return;

    // já enviei numa página anterior e caí aqui: a busca terminou (bem ou mal),
    // não pesquiso de novo — só registro onde parei
    if (e.fase === 'enviado') {
      log('página após o envio');
      limpar();
      return;
    }

    // na tela de login não há o que fazer: o número fica guardado para depois
    if (/\/sip\/login\.php/i.test(location.pathname + location.search)) {
      log('tela de login, número guardado');
      return;
    }

    if (procurando) return;
    procurando = true;

    quandoAssentar(function () {
      var inicio = Date.now();
      (function tentar() {
        var atual = estado();
        if (!atual || atual.fase !== 'pendente') return;   // outro frame já resolveu
        var inp = campo();
        if (inp) { log('campo encontrado, preenchendo'); preencher(inp, atual.n, 0); return; }
        if (Date.now() - inicio > ESPERA_MS) {
          log('campo de pesquisa não apareceu');
          if (window.top === window.self) avisar(atual.n);
          return;
        }
        setTimeout(tentar, 300);
      })();
    });
  }

  // com a aba do SEI já aberta, o sistema só troca o "#" e o navegador não
  // recarrega a página — daí ouvir o hashchange além do carregamento normal
  window.addEventListener('hashchange', function () {
    enviando = false;
    procurando = false;
    iniciar();
  });
  iniciar();
})();
