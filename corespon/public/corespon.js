/*
 * Interfaz del ajedrez por correspondencia.
 *
 * Diferencias clave respecto a `online.js` / `app.js`:
 *  - Plazos de días: cada jugada tiene un plazo de 2 días + 1 h de gracia.
 *  - Prórrogas: el jugador del turno puede ampliar el plazo (+1 día) sin
 *    aprobación del rival.
 *  - Notificaciones WhatsApp automáticas (invitación, turno, recordatorio,
 *    fin de partida).
 *  - Tarjeta de plazo visible en la partida.
 */
(function () {
  'use strict';

  const E = window.ChessEngine;
  const O = window.CoresponOnline;
  if (!E || !O) {
    document.body.textContent = 'No se pudo cargar el motor de ajedrez.';
    return;
  }

  const PLAYERS = ['Manuel', 'Fernan', 'Alberto', 'Alvaro', 'Alejandro', 'Abuelo'];
  const PROMOTION_ORDER = ['queen', 'rook', 'bishop', 'knight'];
  const PROMOTION_NAMES = {
    queen: 'Dama', rook: 'Torre', bishop: 'Alfil', knight: 'Caballo'
  };

  const ERRORS = {
    invalid_code: 'El código debe tener 6 caracteres válidos.',
    not_found: 'No existe ninguna sala con ese código. Revisa el código.',
    full: 'La sala ya tiene dos jugadores.',
    rate_limited: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
    timeout: 'El servidor tarda en responder. Inténtalo de nuevo.',
    offline: 'Sin conexión. Comprueba tu red e inténtalo de nuevo.',
    server_error: 'Error del servidor. Inténtalo de nuevo.',
    not_in_room: 'Ya no estás en esa sala.',
    game_over: 'La partida ya ha terminado.',
    not_your_turn: 'No es tu turno.',
    illegal_move: 'Esa jugada no es legal.',
    waiting_player: 'Tu rival ya no está en la sala.',
    no_session: 'No hay ninguna partida guardada.',
    not_scheduled: 'Esa partida no está programada.',
    not_your_scheduled: 'No es tu turno en esa partida.',
    not_finished: 'La partida aún no ha terminado.'
  };

  const el = {
    lobbyScreen: document.getElementById('lobbyScreen'),
    gameScreen: document.getElementById('gameScreen'),
    playerName: document.getElementById('playerName'),
    rivalName: document.getElementById('rivalName'),
    createBtn: document.getElementById('createBtn'),
    joinForm: document.getElementById('joinForm'),
    joinBtn: document.getElementById('joinBtn'),
    joinName: document.getElementById('joinName'),
    codeInput: document.getElementById('codeInput'),
    lobbyError: document.getElementById('lobbyError'),
    roomCode: document.getElementById('roomCode'),
    copyBtn: document.getElementById('copyBtn'),
    connectionBadge: document.getElementById('connectionBadge'),
    connectionText: document.getElementById('connectionText'),
    flipBtn: document.getElementById('flipBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    board: document.getElementById('board'),
    topPlayer: document.getElementById('topPlayer'),
    topColor: document.getElementById('topColor'),
    topName: document.getElementById('topName'),
    topTag: document.getElementById('topTag'),
    topCaptured: document.getElementById('topCaptured'),
    topMaterial: document.getElementById('topMaterial'),
    bottomPlayer: document.getElementById('bottomPlayer'),
    bottomColor: document.getElementById('bottomColor'),
    bottomName: document.getElementById('bottomName'),
    bottomTag: document.getElementById('bottomTag'),
    bottomCaptured: document.getElementById('bottomCaptured'),
    bottomMaterial: document.getElementById('bottomMaterial'),
    waitingOverlay: document.getElementById('waitingOverlay'),
    waitingCode: document.getElementById('waitingCode'),
    waitingCopyBtn: document.getElementById('waitingCopyBtn'),
    tournamentLink: document.getElementById('tournamentLink'),
    spectatorNote: document.getElementById('spectatorNote'),
    topClock: document.getElementById('topClock'),
    bottomClock: document.getElementById('bottomClock'),
    timeSummary: document.getElementById('timeSummary'),
    promotionOverlay: document.getElementById('promotionOverlay'),
    promotionRow: document.getElementById('promotionRow'),
    cancelPromotionBtn: document.getElementById('cancelPromotionBtn'),
    resultOverlay: document.getElementById('resultOverlay'),
    resultKicker: document.getElementById('resultKicker'),
    resultTitle: document.getElementById('resultTitle'),
    resultText: document.getElementById('resultText'),
    rematchBtn: document.getElementById('rematchBtn'),
    resultLeaveBtn: document.getElementById('resultLeaveBtn'),
    rematchNote: document.getElementById('rematchNote'),
    statusText: document.getElementById('statusText'),
    moveList: document.getElementById('moveList'),
    toast: document.getElementById('toast'),
    partidasSection: document.getElementById('partidasSection'),
    partidasList: document.getElementById('partidasList'),
    clasificacionSection: document.getElementById('clasificacionSection'),
    clasificacionList: document.getElementById('clasificacionList'),
    plazoCard: document.getElementById('plazoCard'),
    plazoIcon: document.getElementById('plazoIcon'),
    plazoStatus: document.getElementById('plazoStatus'),
    plazoText: document.getElementById('plazoText'),
    extendBtn: document.getElementById('extendBtn')
  };

  const squares = [];
  let room = null;
  let myColor = null;
  let orientation = 'white';
  let selected = null;
  let legalMoves = [];
  let drag = null;
  let pendingPromotion = null;
  let movePending = false;
  let rematchPending = false;
  let busy = false;
  let toastTimer = null;
  let isSpectator = false;
  let clockSkew = 0;
  let clockTimer = null;

  // ==================== AYUDANTES ====================

  function other(color) {
    return color === 'white' ? 'black' : 'white';
  }

  function viewColor() {
    return myColor || orientation || 'white';
  }

  function formatMs(milliseconds) {
    const total = Math.max(0, Math.round((milliseconds || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes >= 60) {
      return Math.floor(minutes / 60) + ':'
        + String(minutes % 60).padStart(2, '0') + ':'
        + String(seconds).padStart(2, '0');
    }
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function formatPlazo(msHasta, msGracia, now = Date.now()) {
    const msPlazo = Math.max(0, (msHasta || now) - now);
    const msGraciaR = msGracia ? Math.max(0, msGracia - now) : msPlazo;

    const fmt = (ms) => {
      const total = Math.floor(ms / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const parts = [];
      if (days) parts.push(`${days}d`);
      if (hours) parts.push(`${hours}h`);
      if (minutes) parts.push(`${minutes}m`);
      if (seconds || !parts.length) parts.push(`${seconds}s`);
      return parts.join(' ');
    };

    const fecha = msHasta ? new Date(msHasta).toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }) : '';
    const fechaGracia = msGraciaR
      ? new Date(now + msGraciaR).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      }) : '';

    return {
      msPlazo, msGracia: msGraciaR, texto: `${fmt(msPlazo)} (${fecha})`,
      textoConGracia: msGraciaR > 0 ? `hasta ${fecha}, con gracia hasta ${fechaGracia}` : `hasta ${fecha}`
    };
  }

  function colorLabel(color) {
    return color === 'white' ? 'Blancas' : 'Negras';
  }

  function playerName(color) {
    if (!room) return colorLabel(color);
    const player = room.players[color];
    return player ? player.name : colorLabel(color);
  }

  function errorText(code) {
    return ERRORS[code] || 'Ha ocurrido un error. Inténtalo de nuevo.';
  }

  function showToast(message, type = 'info') {
    el.toast.textContent = message;
    el.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast';
    }, 3400);
  }

  function showLobbyError(message) {
    el.lobbyError.textContent = message;
    el.lobbyError.hidden = !message;
  }

  function clearLobbyError() {
    el.lobbyError.textContent = '';
    el.lobbyError.hidden = true;
  }

  function setBusy(value) {
    busy = value;
    el.createBtn.disabled = value;
    el.joinBtn.disabled = value;
    el.codeInput.disabled = value;
    const label = el.createBtn.querySelector('span');
    if (label) label.textContent = value ? 'Creando…' : 'Crear sala';
  }

  function clearSelection() {
    selected = null;
    legalMoves = [];
  }

  function updateUrl(code) {
    try {
      window.history.replaceState(null, '', code ? '/corespon/' + code : '/corespon');
    } catch (error) {
      // history no disponible: no pasa nada
    }
  }

  // Código de sala desde /corespon/CODE (enlaces de WhatsApp) o ?code=CODE.
  function codeFromUrl() {
    const match = window.location.pathname.match(/\/corespon\/([A-Za-z0-9]{6})\/?$/);
    if (match) return match[1].toUpperCase();
    const param = new URLSearchParams(window.location.search).get('code');
    return param ? param.trim().toUpperCase() : null;
  }

  // ==================== PANTALLAS ====================

  function showLobby() {
    document.body.classList.remove('in-game');
    el.lobbyScreen.hidden = false;
    el.gameScreen.hidden = true;
    loadPartidasAbiertas();
    loadClasificacion();
  }

  function showGame() {
    document.body.classList.add('in-game');
    el.lobbyScreen.hidden = true;
    el.gameScreen.hidden = false;
  }

  function enterGame() {
    if (!room) return;
    if (!isSpectator && !myColor) myColor = O.getColor() || 'white';
    if (!orientation) orientation = myColor || 'white';
    document.body.classList.toggle('is-spectator', isSpectator);
    el.spectatorNote.hidden = !isSpectator;
    showGame();
    el.roomCode.textContent = room.code;
    el.waitingCode.textContent = room.code;
    updateUrl(room.code);
    clearSelection();
    pendingPromotion = null;
    movePending = false;
    el.promotionOverlay.hidden = true;
    render();
    startClockLoop();
    renderPlazoCard();
  }

  // ==================== TABLERO ====================

  function buildBoard() {
    for (let index = 0; index < 64; index++) {
      const square = document.createElement('div');
      square.className = 'square';
      square.setAttribute('role', 'gridcell');
      el.board.appendChild(square);
      squares.push(square);
    }
  }

  function squareLabel(row, col, piece) {
    const name = E.FILES[col] + (8 - row);
    if (!piece || piece === ' ') return name + ', vacía';
    const type = E.typeOf(piece);
    const color = E.colorOf(piece) === 'white' ? 'blanca' : 'negra';
    return name + ', ' + E.PIECE_NAMES[type] + ' ' + color;
  }

  function renderBoard() {
    if (!room) return;
    const board = room.state.board;
    const flipped = orientation === 'black';
    const inCheck = E.isInCheck(board, room.state.turn);
    const king = inCheck ? E.findKing(board, room.state.turn) : null;

    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const row = flipped ? 7 - dr : dr;
        const col = flipped ? 7 - dc : dc;
        const square = squares[dr * 8 + dc];

        square.dataset.row = String(row);
        square.dataset.col = String(col);
        square.className = 'square ' + ((row + col) % 2 === 0 ? 'light' : 'dark');
        square.replaceChildren();

        const piece = board[row][col];
        if (piece !== ' ') {
          const pieceEl = document.createElement('span');
          pieceEl.className = 'piece '
            + (E.colorOf(piece) === 'white' ? 'piece-white' : 'piece-black');
          pieceEl.textContent = E.BLACK_PIECES[E.typeOf(piece)];
          pieceEl.setAttribute('aria-hidden', 'true');
          square.appendChild(pieceEl);
        }

        if (room.state.lastMove) {
          const { from, to } = room.state.lastMove;
          if ((from[0] === row && from[1] === col)
              || (to[0] === row && to[1] === col)) {
            square.classList.add('last-move');
          }
        }

        if (selected && selected.row === row && selected.col === col) {
          square.classList.add('selected');
        }

        if (selected) {
          for (const move of legalMoves) {
            if (move.row !== row || move.col !== col) continue;
            if (move.special === 'castling') square.classList.add('castling-path');
            else if (move.special === 'enpassant') square.classList.add('en-passant-target');
            else if (move.capture) square.classList.add('valid-capture');
            else square.classList.add('valid-move');
          }
        }

        if (king && king.row === row && king.col === col) {
          square.classList.add('check');
        }

        if (drag && drag.active && drag.row === row && drag.col === col) {
          square.classList.add('dragging');
        }

        square.setAttribute('aria-label', squareLabel(row, col, piece));
      }
    }
  }

  function renderBar(position, color) {
    const player = room.players[color];
    const isTop = position === 'top';
    const colorEl = isTop ? el.topColor : el.bottomColor;
    const nameEl = isTop ? el.topName : el.bottomName;
    const tagEl = isTop ? el.topTag : el.bottomTag;
    const capturedEl = isTop ? el.topCaptured : el.bottomCaptured;
    const materialEl = isTop ? el.topMaterial : el.bottomMaterial;
    const bar = isTop ? el.topPlayer : el.bottomPlayer;

    colorEl.className = 'player-color ' + color;
    colorEl.textContent = E.BLACK_PIECES.king;

    bar.classList.toggle('waiting', !player);
    bar.classList.toggle('active',
      !room.status.over && !!player && room.state.turn === color);
    bar.classList.toggle('offline', !!player && !player.connected);

    if (!player) {
      nameEl.textContent = isTop ? 'Esperando rival…' : 'Tú';
      tagEl.textContent = isTop ? 'Rival' : 'Tú';
      capturedEl.replaceChildren();
      capturedEl.setAttribute('aria-label', 'Sin rival todavía');
      materialEl.textContent = '';
      return;
    }

    nameEl.textContent = player.name;
    tagEl.textContent = isSpectator
      ? colorLabel(color)
      : (isTop ? 'Rival' : 'Tú') + ' · ' + colorLabel(color);

    capturedEl.replaceChildren();
    const captured = room.state.captured[color] || [];
    const counts = {};
    for (const type of captured) counts[type] = (counts[type] || 0) + 1;

    if (!captured.length) {
      const empty = document.createElement('span');
      empty.className = 'captured-empty';
      empty.textContent = 'Sin capturas';
      capturedEl.appendChild(empty);
    } else {
      for (const type of E.CAPTURE_ORDER) {
        const count = counts[type] || 0;
        if (!count) continue;

        const group = document.createElement('span');
        group.className = 'captured-group';

        const glyph = document.createElement('span');
        glyph.className = 'captured-piece '
          + (other(color) === 'white' ? 'piece-white' : 'piece-black');
        glyph.textContent = E.BLACK_PIECES[type];
        group.appendChild(glyph);

        if (count > 1) {
          const times = document.createElement('span');
          times.className = 'captured-count';
          times.textContent = '×' + count;
          group.appendChild(times);
        }

        capturedEl.appendChild(group);
      }
    }

    const summary = E.capturedSummary(captured)
      .map(item => item.count + ' ' + item.name)
      .join(', ');
    capturedEl.setAttribute(
      'aria-label',
      'Capturas de ' + player.name + ': ' + (summary || 'ninguna')
    );

    const advantage = color === 'white'
      ? E.materialAdvantage(room.state.captured)
      : -E.materialAdvantage(room.state.captured);
    materialEl.textContent = advantage > 0 ? '+' + advantage : '';
  }

  function renderPlayers() {
    if (isSpectator) {
      renderBar('top', other(viewColor()));
      renderBar('bottom', viewColor());
      return;
    }
    if (!myColor) return;
    renderBar('top', other(myColor));
    renderBar('bottom', myColor);
  }

  function renderPlazoCard() {
    if (!room) return;
    const isYou = !isSpectator && room.state.turn === myColor;
    const over = room.status.over;

    if (isYou && !over) {
      el.plazoCard.hidden = false;
      el.plazoIcon.textContent = '⏰';
      el.plazoStatus.textContent = 'Tu turno';
      renderPlazoText();
      el.extendBtn.disabled = !room.canExtend;
      el.extendBtn.textContent = `Ampliar +1 día (${room.maxProrrogas - room.prorrogas} restantes)`;
    } else if (over) {
      el.plazoCard.hidden = true;
    } else {
      // es turno del rival
      el.plazoCard.hidden = false;
      el.plazoIcon.textContent = '♟';
      el.plazoStatus.textContent = 'Turno del rival';
      renderPlazoText();
      el.extendBtn.disabled = true;
      el.extendBtn.textContent = 'Esperando jugada…';
    }
  }

  function renderPlazoText() {
    if (!room || !room.plazo) return;
    const plazo = formatPlazo(room.plazo.plazoHasta, room.plazo.graciaHasta);
    const esTuTurno = !isSpectator && room.state.turn === myColor;
    const texto = esTuTurno ? plazo.textoConGracia : plazo.texto;
    el.plazoText.textContent = texto;
  }

  // ==================== ESTADO ====================

  function renderStatus() {
    if (!room) return;

    if (isSpectator) {
      if (room.status.over) {
        el.statusText.textContent = spectatorResult(room.status).status;
        return;
      }
      const current = playerName(room.state.turn);
      const suffix = room.status.inCheck ? ' · ¡Jaque!' : '';
      const watching = room.spectators > 1
        ? ' · ' + (room.spectators - 1) + ' mirando'
        : '';
      el.statusText.textContent = 'Turno de ' + current + suffix + watching;
      return;
    }

    const opponent = other(myColor);
    const opponentName = playerName(opponent);

    if (room.status.over) {
      el.statusText.textContent = resultInfo(room.status, opponentName).status;
      return;
    }

    if (!O.isConnected()) {
      el.statusText.textContent = 'Sin conexión. Reconectando…';
      return;
    }

    if (!room.players[opponent]) {
      el.statusText.textContent = 'Esperando a que se una un rival…';
      return;
    }

    if (movePending) {
      el.statusText.textContent = 'Enviando jugada…';
      return;
    }

    const parts = [];
    const chip = document.createElement('span');
    chip.className = 'turn-chip ' + room.state.turn;
    chip.textContent = room.state.turn === 'white' ? 'Blancas' : 'Negras';
    parts.push(chip);

    const text = document.createElement('span');
    text.textContent = room.state.turn === myColor
      ? 'Tu turno'
      : 'Turno de ' + opponentName;
    parts.push(text);

    if (room.status.inCheck) {
      const check = document.createElement('span');
      check.className = 'status-check';
      check.textContent = ' · ¡Jaque!';
      parts.push(check);
    }

    if (room.players[opponent] && !room.players[opponent].connected) {
      const offline = document.createElement('span');
      offline.className = 'status-muted';
      offline.textContent = ' · Rival desconectado';
      parts.push(offline);
    }

    if (room.spectators > 0) {
      const watching = document.createElement('span');
      watching.className = 'status-muted';
      watching.textContent = ' · ' + room.spectators
        + (room.spectators === 1 ? ' espectador' : ' espectadores');
      parts.push(watching);
    }

    el.statusText.replaceChildren(...parts);
  }

  function renderMoveList() {
    const history = room.history || [];
    el.moveList.replaceChildren();

    if (!history.length) {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'Sin jugadas todavía';
      el.moveList.appendChild(empty);
      return;
    }

    for (let index = 0; index < history.length; index += 2) {
      const pair = document.createElement('span');
      pair.className = 'move-pair';

      const number = document.createElement('span');
      number.className = 'move-num';
      number.textContent = (index / 2 + 1) + '.';
      pair.appendChild(number);

      const move = document.createElement('span');
      move.className = 'move-san';
      move.textContent = history[index].notation || E.notationFor(room.state, history[index], {});
      pair.appendChild(move);

      if (history[index + 1]) {
        const move2 = document.createElement('span');
        move2.className = 'move-san';
        move2.textContent = history[index + 1].notation || '';
        pair.appendChild(move2);
      }

      el.moveList.appendChild(pair);
    }

    requestAnimationFrame(() => {
      el.moveList.scrollLeft = el.moveList.scrollWidth;
      el.moveList.scrollTop = el.moveList.scrollHeight;
    });
  }

  function renderClocks() {
    if (!room || !room.timing) return;
    const msPlazo = Math.max(0, (room.plazo.plazoHasta || Date.now()) - Date.now());
    const msGracia = Math.max(0, (room.plazo.graciaHasta || room.plazo.plazoHasta) - Date.now());

    const rows = [
      { node: el.topClock, color: other(viewColor()) },
      { node: el.bottomClock, color: viewColor() }
    ];
    for (const row of rows) {
      const plazo = formatPlazo(room.plazo.plazoHasta, room.plazo.graciaHasta);
      row.node.textContent = plazo.texto;
      row.node.classList.toggle(
        'ticking',
        !room.status.over && room.state.turn === row.color
      );
      row.node.classList.toggle('is-you', !isSpectator && row.color === myColor);
    }
  }

  function spectatorResult(status) {
    if (status.winner === 'white' || status.winner === 'black') {
      const winner = playerName(status.winner);
      const loser = playerName(other(status.winner));
      return {
        title: 'Victoria de ' + winner,
        text: winner + ' gana la partida contra ' + loser + '.',
        status: 'Victoria de ' + winner + '.'
      };
    }
    return {
      title: 'Tablas',
      text: 'La partida ha terminado en tablas.',
      status: 'Tablas.'
    };
  }

  function renderOverlays() {
    const opponent = other(viewColor());
    const waiting = !isSpectator && !room.status.over && !room.players[opponent];
    el.waitingOverlay.hidden = !waiting;
    if (waiting) el.waitingCode.textContent = room.code;

    el.promotionOverlay.hidden = !pendingPromotion || isSpectator;

    const over = room.status.over;
    el.resultOverlay.hidden = !over;
    el.resultLeaveBtn.textContent = isSpectator ? 'Volver a la lista' : 'Salir';

    if (!over) return;

    const info = isSpectator
      ? spectatorResult(room.status)
      : resultInfo(room.status, playerName(opponent));
    el.resultKicker.textContent = room.status.reason === 'checkmate'
      ? 'Jaque mate'
      : 'Fin de la partida';
    el.resultTitle.textContent = info.title;
    el.resultText.textContent = info.text;

    const canRematch = !isSpectator && !!(room.players[opponent] && room.players[myColor]);
    el.rematchBtn.hidden = !canRematch;
    el.rematchBtn.disabled = rematchPending;
    el.rematchBtn.textContent = rematchPending ? 'Esperando…' : 'Revancha';

    let note = '';
    if (!canRematch) note = 'Tu rival ha salido de la sala.';
    el.rematchNote.textContent = note;
    el.rematchNote.hidden = !note;
  }

  function render() {
    if (!room) return;
    if (!isSpectator && !myColor) myColor = O.getColor() || 'white';
    renderBoard();
    renderPlayers();
    renderStatus();
    renderMoveList();
    renderClocks();
    renderOverlays();
    renderPlazoCard();
  }

  // ==================== RESULTADO ====================

  function resultInfo(status, opponentName) {
    const win = status.winner === myColor;
    switch (status.reason) {
      case 'checkmate':
        return win
          ? {
              title: '¡Jaque mate!',
              text: 'Has ganado la partida contra ' + opponentName + '.',
              status: 'Jaque mate. ¡Has ganado!'
            }
          : {
              title: 'Jaque mate',
              text: opponentName + ' te ha dado jaque mate.',
              status: 'Jaque mate. Gana ' + opponentName + '.'
            };
      case 'stalemate':
        return {
          title: 'Tablas',
          text: 'El rey no tiene jugadas legales, pero no está en jaque: ahogado.',
          status: 'Tablas por ahogado.'
        };
      case 'insufficient':
        return {
          title: 'Tablas',
          text: 'No queda material suficiente para dar jaque mate.',
          status: 'Tablas por material insuficiente.'
        };
      case 'fifty-move':
        return {
          title: 'Tablas',
          text: 'Se han jugado 50 movimientos sin capturas ni peones.',
          status: 'Tablas por la regla de 50 jugadas.'
        };
      case 'resignation':
        return win
          ? {
              title: 'Victoria',
              text: opponentName + ' se ha rendido.',
              status: opponentName + ' se rindió. ¡Has ganado!'
            }
          : {
              title: 'Derrota',
              text: 'Te has rendido.',
              status: 'Te has rendido.'
            };
      case 'time':
        return win
          ? {
              title: 'Victoria',
              text: opponentName + ' se agotó el tiempo.',
              status: opponentName + ' perdió por tiempo. ¡Has ganado!'
            }
          : {
              title: 'Derrota por tiempo',
              text: 'Se agotó tu tiempo. Has perdido la partida.',
              status: 'Has perdido por tiempo.'
            };
      case 'abandonment':
        return win
          ? {
              title: 'Victoria',
              text: opponentName + ' ha abandonado la sala.',
              status: opponentName + ' abandonó. ¡Has ganado!'
            }
          : {
              title: 'Partida abandonada',
              text: 'Has abandonado la partida.',
              status: 'Has abandonado la partida.'
            };
      default:
        return {
          title: 'Fin de la partida',
          text: 'La partida ha terminado.',
          status: 'Fin de la partida.'
        };
    }
  }

  // ==================== INTERACCIÓN ====================

  function canInteract() {
    if (!room || !myColor) return false;
    if (room.status.over || pendingPromotion || movePending) return false;
    if (!O.isConnected()) return false;
    if (room.state.turn !== myColor) return false;
    if (!room.players[myColor]) return false;
    if (!room.players[other(myColor)]) return false;
    return true;
  }

  function onBoardPointerDown(event) {
    if (!room || drag) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.isPrimary === false) return;

    const square = event.target.closest('.square');
    if (!square) return;
    event.preventDefault();

    const row = Number(square.dataset.row);
    const col = Number(square.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;

    if (!canInteract()) {
      const piece = room.state.board[row][col];
      if (isSpectator) {
        showToast('Estás mirando la partida.');
      } else if (!O.isConnected()) {
        showToast('Sin conexión. Reconectando…', 'error');
      } else if (!room.status.over && piece !== ' '
          && E.colorOf(piece) === myColor && room.state.turn !== myColor) {
        showToast('Espera tu turno.');
      } else if (!room.players[other(myColor)]) {
        showToast('Todavía no hay rival. Comparte el enlace.');
      }
      return;
    }

    try {
      el.board.setPointerCapture(event.pointerId);
    } catch (error) {
      // algunos navegadores no lo permiten; seguimos con listeners globales
    }

    const piece = room.state.board[row][col];
    if (piece !== ' ' && E.colorOf(piece) === myColor) {
      if (selected && selected.row === row && selected.col === col) {
        clearSelection();
        renderBoard();
        return;
      }
      selected = { row, col };
      legalMoves = E.legalMovesFor(row, col, room.state.board, room.state);
      drag = {
        row,
        col,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        clone: null,
        pointerId: event.pointerId
      };
      renderBoard();
      return;
    }

    if (selected && trySquare(row, col)) return;

    if (selected) {
      clearSelection();
      renderBoard();
    }
  }

  function trySquare(row, col) {
    const move = legalMoves.find(item => item.row === row && item.col === col);
    if (!move) return false;

    if (move.special === 'promotion') {
      pendingPromotion = {
        from: { row: selected.row, col: selected.col },
        to: { row, col },
        color: myColor
      };
      clearSelection();
      renderBoard();
      openPromotion();
      return true;
    }

    sendMove(selected, { row, col });
    return true;
  }

  function onPointerMove(event) {
    if (!drag || !room) return;
    if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.active && Math.hypot(dx, dy) > 6) {
      const piece = room.state.board[drag.row][drag.col];
      if (!piece || piece === ' ') {
        drag = null;
        return;
      }
      drag.active = true;
      const clone = document.createElement('span');
      clone.className = 'drag-clone '
        + (E.colorOf(piece) === 'white' ? 'piece-white' : 'piece-black');
      clone.textContent = E.BLACK_PIECES[E.typeOf(piece)];
      clone.style.left = event.clientX + 'px';
      clone.style.top = event.clientY + 'px';
      document.body.appendChild(clone);
      drag.clone = clone;
      renderBoard();
    }

    if (drag.active && drag.clone) {
      drag.clone.style.left = event.clientX + 'px';
      drag.clone.style.top = event.clientY + 'px';
    }
  }

  function onPointerUp(event) {
    if (!drag) return;
    if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;

    const wasActive = drag.active;
    const startRow = drag.row;
    const startCol = drag.col;
    const clone = drag.clone;
    drag = null;

    if (clone) clone.remove();
    try {
      if (el.board.hasPointerCapture(event.pointerId)) {
        el.board.releasePointerCapture(event.pointerId);
      }
    } catch (error) {
      // nada que hacer
    }

    if (!wasActive) {
      // Fue un toque: la selección ya se hizo en pointerdown.
      renderBoard();
      return;
    }

    if (!room) return;

    const rect = el.board.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const displayCol = Math.floor((x / rect.width) * 8);
    const displayRow = Math.floor((y / rect.height) * 8);

    if (displayRow < 0 || displayRow > 7 || displayCol < 0 || displayCol > 7) {
      renderBoard();
      return;
    }

    const flipped = orientation === 'black';
    const row = flipped ? 7 - displayRow : displayRow;
    const col = flipped ? 7 - displayCol : displayCol;

    if (row === startRow && col === startCol) {
      renderBoard();
      return;
    }

    if (!selected || selected.row !== startRow || selected.col !== startCol) {
      selected = { row: startRow, col: startCol };
      legalMoves = E.legalMovesFor(startRow, startCol, room.state.board, room.state);
    }

    if (!trySquare(row, col)) {
      renderBoard();
    }
  }

  function onPointerCancel() {
    if (!drag) return;
    if (drag.clone) drag.clone.remove();
    drag = null;
    renderBoard();
  }

  // ==================== JUGADAS ====================

  function sendMove(from, to, promotion) {
    if (movePending) return;
    movePending = true;
    clearSelection();
    renderBoard();
    renderStatus();

    O.sendMove([from.row, from.col], [to.row, to.col], promotion).then((response) => {
      movePending = false;
      if (!response.ok) {
        showToast(errorText(response.error), 'error');
        render();
        return;
      }
      if (response.room) room = response.room;
      render();
    });
  }

  function openPromotion() {
    if (!pendingPromotion) return;
    el.promotionRow.replaceChildren();
    for (const type of PROMOTION_ORDER) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'promotion-btn '
        + (pendingPromotion.color === 'white' ? 'piece-white' : 'piece-black');
      button.textContent = E.BLACK_PIECES[type];
      button.setAttribute('aria-label', 'Coronar ' + PROMOTION_NAMES[type]);
      button.addEventListener('click', () => choosePromotion(type));
      el.promotionRow.appendChild(button);
    }
    el.promotionOverlay.hidden = false;
  }

  function choosePromotion(type) {
    const promotion = pendingPromotion;
    pendingPromotion = null;
    el.promotionOverlay.hidden = true;
    if (!promotion) return;
    sendMove(promotion.from, promotion.to, type.toLowerCase());
  }

  function cancelPromotion() {
    pendingPromotion = null;
    el.promotionOverlay.hidden = true;
    clearSelection();
    renderBoard();
  }

  // ==================== PRÓRROGA ====================

  async function requestExtension() {
    if (!room || !O.isConnected()) return;
    const response = await O.extendRoom(room.code, myColor);
    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      return;
    }
    room = response.room;
    renderPlazoCard();
    renderPlazoText();
    showToast('Plazo ampliado: ' + response.plazo.texto);
  }

  // ==================== LOBBY ====================

  async function loadPartidasAbiertas() {
    try {
      const res = await fetch('/api/partidas');
      const data = await res.json();
      if (!data.ok) {
        el.partidasList.innerHTML = '<p class="empty">No se pudo cargar la lista.</p>';
        return;
      }
      const partidas = data.partidas;
      if (!partidas.length) {
        el.partidasList.innerHTML = '<p class="empty">No hay partidas abiertas en este momento.</p>';
        return;
      }
      el.partidasList.innerHTML = '';
      for (const p of partidas) {
        const item = document.createElement('div');
        item.className = 'partida-item';
        item.innerHTML = `
          <div class="partida-players">
            <strong>${p.blancas}</strong> vs <strong>${p.negras}</strong>
          </div>
          <div class="partida-plazo">
            <span class="plazo-badge" title="Cauca hasta ${p.plazoHasta}">
              ⏰ Plazo: ${formatFecha(p.plazoHasta)}
            </span>
          </div>
          <button class="btn btn-primary btn-sm ver-partida" data-code="${p.roomCode}">
            Ver partida
          </button>
        `;
        item.querySelector('.ver-partida').addEventListener('click', () =>
          joinViaCode(p.roomCode, p.blancas === el.playerName.value ? p.blancas : p.negras)
        );
        el.partidasList.appendChild(item);
      }
    } catch (error) {
      console.error('Error cargando partidas:', error);
    }
  }

  async function loadClasificacion() {
    try {
      const res = await fetch('/api/classification');
      const data = await res.json();
      if (!data.ok) {
        el.clasificacionList.innerHTML = '<p class="empty">No se pudo cargar la clasificación.</p>';
        return;
      }

      const filas = Array.isArray(data.clasificacion) ? data.clasificacion : [];
      el.clasificacionList.replaceChildren();

      if (!filas.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Aún no hay resultados.';
        el.clasificacionList.appendChild(empty);
        return;
      }

      const table = document.createElement('table');
      table.className = 'clasificacion-table';

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['Jugador', 'Partidas', 'Puntos', 'V', 'E', 'D']) {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const fila of filas) {
        const tr = document.createElement('tr');
        const celdas = [
          fila.nombre,
          fila.partidas,
          Number(fila.puntos).toFixed(2),
          fila.victorias,
          fila.empates,
          fila.derrotas
        ];
        for (const valor of celdas) {
          const td = document.createElement('td');
          td.textContent = String(valor);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.clasificacionList.appendChild(table);
    } catch (error) {
      console.error('Error cargando clasificación:', error);
    }
  }

  function formatFecha(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
        + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  function joinViaCode(code, name) {
    el.codeInput.value = code.toUpperCase();
    el.joinName.value = name;
    el.joinForm.requestSubmit();
  }

  async function attemptResume() {
    if (busy) return;
    O.enableAutoResume();
    setBusy(true);
    clearLobbyError();

    const response = await O.resume();
    setBusy(false);

    if (response.ok) {
      myColor = response.color;
      orientation = response.color;
      room = response.room || O.getRoom();
      enterGame();
      showToast('Partida recuperada');
      return;
    }

    showLobby();
    if (response.error === 'not_found' || response.error === 'invalid_code'
        || response.error === 'full' || response.error === 'no_session') {
      showLobbyError('Tu partida anterior ya no está disponible. Crea una sala nueva.');
      return;
    }

    showToast(errorText(response.error), 'error');
  }

  async function handleCreate() {
    if (busy) return;
    const name = el.playerName.value;
    const rival = el.rivalName.value;
    if (!name || !rival) {
      showToast('Selecciona tu nombre y el de tu rival.', 'error');
      return;
    }
    if (name === rival) {
      showToast('El rival no puede ser tú mismo.', 'error');
      return;
    }

    setBusy(true);
    clearLobbyError();

    try {
      const res = await fetch('/api/partidas/invitar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blancas: name, negras: rival })
      });
      const data = await res.json();
      setBusy(false);

      if (!data.ok) {
        showLobbyError(data.error || 'No se pudo crear la sala.');
        return;
      }

      myColor = data.color;
      orientation = data.color;

      // Unirse a la sala por socket con el nombre propio
      const joined = await O.joinRoom(data.room.code, name);
      if (!joined.ok) {
        showLobbyError(errorText(joined.error));
        return;
      }

      room = joined.room;
      enterGame();
      showToast('Sala creada. El rival recibirá una invitación por WhatsApp.');
    } catch (error) {
      setBusy(false);
      showLobbyError('Error de conexión con el servidor.');
    }
  }

  async function handleJoin(event) {
    if (event) event.preventDefault();
    if (busy) return;

    const code = el.codeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      showLobbyError('El código de sala tiene 6 caracteres.');
      return;
    }

    const name = el.joinName.value;
    setBusy(true);
    clearLobbyError();

    try {
      const response = await O.joinRoom(code, name);
      setBusy(false);

      if (!response.ok) {
        showLobbyError(errorText(response.error));
        return;
      }

      myColor = response.color;
      orientation = response.color;
      room = response.room;
      enterGame();
      showToast(response.resumed ? 'Partida recuperada' : 'Te has unido a la sala');
    } catch (error) {
      setBusy(false);
      showLobbyError('Error de conexión con el servidor.');
    }
  }

  async function leaveGame(confirmFirst) {
    if (isSpectator) {
      await O.stopWatching();
      window.location.href = '/corespon';
      return;
    }

    if (!room) {
      showLobby();
      updateUrl(null);
      return;
    }

    const opponent = other(myColor);
    const inProgress = !room.status.over && !!room.players[opponent];
    if (confirmFirst && inProgress) {
      const confirmed = window.confirm(
        '¿Salir de la partida? Se contará como abandono.'
      );
      if (!confirmed) return;
    }

    await O.leaveRoom();
    room = null;
    myColor = null;
    pendingPromotion = null;
    rematchPending = false;
    movePending = false;
    clearSelection();
    showLobby();
    updateUrl(null);
    showToast('Has salido de la sala');
  }

  // ==================== COPIAR ENLACE ====================

  async function copyInvite() {
    if (!room) return;
    const url = window.location.origin + '/corespon/' + room.code;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Enlace copiado al portapapeles');
      return;
    } catch (error) {
      // Fallback para navegadores sin clipboard API
    }

    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      showToast('Enlace copiado al portapapeles');
    } catch (error) {
      showToast('Copia este enlace: ' + url, 'error');
    }
    input.remove();
  }

  // ==================== EVENTOS DE RED ====================

  O.on('room', (payload) => {
    if (!payload) return;
    const wasOver = !!(room && room.status.over);
    room = payload;

    if (!myColor && !isSpectator) {
      const session = O.getSession();
      if (session) myColor = session.color;
    }

    if (wasOver && !payload.status.over) {
      rematchPending = false;
      pendingPromotion = null;
      movePending = false;
      el.promotionOverlay.hidden = true;
      clearSelection();
      orientation = myColor || orientation;
      showToast('¡Nueva partida!');
    }

    if (selected) {
      const piece = payload.state.board[selected.row][selected.col];
      if (payload.status.over || payload.state.turn !== myColor
          || !piece || piece === ' ' || E.colorOf(piece) !== myColor) {
        clearSelection();
      }
    }

    renderPlazoCard();
    if (!el.gameScreen.hidden) render();
  });

  // Revancha: el servidor intercambió los colores y nos dice cuál tenemos.
  O.on('color', (payload) => {
    if (!payload || !payload.color) return;
    myColor = payload.color;
    orientation = payload.color;
    pendingPromotion = null;
    movePending = false;
    clearSelection();
    el.promotionOverlay.hidden = true;
    if (room) render();
  });

  O.on('joined', (payload) => {
    if (!payload || !payload.room) return;
    const previousColor = myColor;
    myColor = payload.color;
    room = payload.room;
    if (previousColor && previousColor !== payload.color) {
      orientation = payload.color;
      clearSelection();
      pendingPromotion = null;
      el.promotionOverlay.hidden = true;
    }
    if (el.gameScreen.hidden) {
      orientation = payload.color;
      enterGame();
    } else {
      render();
    }
  });

  O.on('connection', (payload) => {
    const badge = el.connectionBadge;
    badge.classList.remove('warn', 'bad');
    if (payload.status === 'connected') {
      el.connectionText.textContent = 'En línea';
    } else if (payload.status === 'reconnecting') {
      badge.classList.add('warn');
      el.connectionText.textContent = 'Reconectando…';
      movePending = false;
    } else {
      badge.classList.add('bad');
      el.connectionText.textContent = 'Sin conexión';
      movePending = false;
      if (drag) {
        if (drag.clone) drag.clone.remove();
        drag = null;
      }
    }
    if (room && !el.gameScreen.hidden) renderStatus();
  });

  O.on('session-lost', () => {
    if (busy) return;
    room = null;
    myColor = null;
    showLobby();
    updateUrl(null);
    showLobbyError('La sala ya no existe o ha caducado.');
  });

  O.on('left', () => {
    room = null;
    myColor = null;
    showLobby();
    updateUrl(null);
  });

  O.on('extendResult', (payload) => {
    if (!payload) return;
    room = payload.room;
    renderPlazoCard();
    showToast('Plazo ampliado.');
  });

  // ==================== EVENTOS DE UI ====================

  el.playerName.addEventListener('change', () => {
    const name = el.playerName.value.trim();
    if (name) O.setName(name);
  });

  el.rivalName.addEventListener('change', () => {
    const name = el.rivalName.value.trim();
    el.createBtn.disabled = !name;
  });

  el.joinName.addEventListener('change', () => {
    const name = el.joinName.value.trim();
    if (name) O.setName(name);
  });

  el.createBtn.addEventListener('click', handleCreate);
  el.joinForm.addEventListener('submit', handleJoin);

  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = el.codeInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
  });

  el.copyBtn.addEventListener('click', copyInvite);
  el.waitingCopyBtn.addEventListener('click', copyInvite);
  el.extendBtn.addEventListener('click', requestExtension);

  el.flipBtn.addEventListener('click', () => {
    orientation = orientation === 'white' ? 'black' : 'white';
    clearSelection();
    renderBoard();
  });

  el.leaveBtn.addEventListener('click', () => leaveGame(true));
  el.resultLeaveBtn.addEventListener('click', () => leaveGame(false));
  el.cancelPromotionBtn.addEventListener('click', cancelPromotion);

  el.rematchBtn.addEventListener('click', async () => {
    if (rematchPending) return;
    rematchPending = true;
    renderOverlays();
    const response = await O.rematch();
    rematchPending = false;
    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      render();
      return;
    }
    if (!response.started) showToast('Revancha solicitada. Esperando al rival…');
    render();
  });

  el.board.addEventListener('pointerdown', onBoardPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);

  // Inicialización
  function init() {
    buildBoard();

    const savedName = O.getName();
    if (savedName) {
      el.playerName.value = savedName;
      el.joinName.value = savedName;
    }

    // Rellenar selects con la lista de jugadores
    for (const p of PLAYERS) {
      const opt1 = document.createElement('option');
      opt1.value = p;
      opt1.textContent = p;
      el.playerName.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = p;
      opt2.textContent = p;
      el.rivalName.appendChild(opt2);

      const opt3 = document.createElement('option');
      opt3.value = p;
      opt3.textContent = p;
      el.joinName.appendChild(opt3);
    }

    if (savedName) {
      const idx = PLAYERS.indexOf(savedName);
      if (idx !== -1) {
        el.playerName.selectedIndex = idx + 1;
        el.rivalName.selectedIndex = idx + 1;
        el.joinName.selectedIndex = idx + 1;
      }
    }

    showLobby();

    const session = O.getSession();
    const urlCode = codeFromUrl();
    if (session && session.code && (!urlCode || urlCode === session.code)) {
      attemptResume();
    } else if (urlCode) {
      el.codeInput.value = urlCode;
    }

    const online = O.isConnected();
    el.connectionBadge.classList.toggle('warn', !online);
  }

  init();
})();
