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

  // Roster de reserva: se usa solo si /api/players no responde.
  const PLAYERS = ['Manuel', 'Fernan', 'Alberto', 'Alvaro', 'Alejandro', 'Abuelo'];
  const ADMIN_TOKEN_KEY = 'corespon.adminToken';
  const ADMIN_OPEN_KEY = 'corespon.adminOpen';
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
    not_finished: 'La partida aún no ha terminado.',
    not_your_game: 'Esa partida no es tuya: comprueba el nombre elegido.',
    seat_taken: 'Ese asiento está ocupado ahora mismo en otro dispositivo. Espera unos segundos y vuelve a intentarlo.',
    pin_requerido: 'Escribe tu clave para entrar (4-6 dígitos).',
    pin_incorrecto: 'Clave incorrecta. Vuelve a intentarlo.',
    pin_invalido: 'La clave debe tener de 4 a 6 dígitos.',
    alta_cerrada: 'El alta de claves está cerrada. Pídele al administrador que la abra.'
  };

  const el = {
    lobbyScreen: document.getElementById('lobbyScreen'),
    gameScreen: document.getElementById('gameScreen'),
    playerName: document.getElementById('playerName'),
    rivalName: document.getElementById('rivalName'),
    playerColor: document.getElementById('playerColor'),
    createBtn: document.getElementById('createBtn'),
    joinForm: document.getElementById('joinForm'),
    joinBtn: document.getElementById('joinBtn'),
    joinName: document.getElementById('joinName'),
    joinPin: document.getElementById('joinPin'),
    createPin: document.getElementById('createPin'),
    codeInput: document.getElementById('codeInput'),
    lobbyError: document.getElementById('lobbyError'),
    roomCode: document.getElementById('roomCode'),
    copyBtn: document.getElementById('copyBtn'),
    connectionBadge: document.getElementById('connectionBadge'),
    connectionText: document.getElementById('connectionText'),
    flipBtn: document.getElementById('flipBtn'),
    lobbyBtn: document.getElementById('lobbyBtn'),
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
    adminSection: document.getElementById('adminSection'),
    adminToggleBtn: document.getElementById('adminToggleBtn'),
    adminPanel: document.getElementById('adminPanel'),
    adminForm: document.getElementById('adminForm'),
    adminToken: document.getElementById('adminToken'),
    adminPlayerName: document.getElementById('adminPlayerName'),
    adminAddBtn: document.getElementById('adminAddBtn'),
    adminStatus: document.getElementById('adminStatus'),
    adminPlayers: document.getElementById('adminPlayers'),
    adminRotateBtn: document.getElementById('adminRotateBtn'),
    adminEnrollmentState: document.getElementById('adminEnrollmentState'),
    adminEnroll2Btn: document.getElementById('adminEnroll2Btn'),
    adminEnroll24Btn: document.getElementById('adminEnroll24Btn'),
    adminEnrollCloseBtn: document.getElementById('adminEnrollCloseBtn'),
    plazoCard: document.getElementById('plazoCard'),
    plazoIcon: document.getElementById('plazoIcon'),
    plazoStatus: document.getElementById('plazoStatus'),
    plazoText: document.getElementById('plazoText'),
    extendBtn: document.getElementById('extendBtn'),
    drawBtn: document.getElementById('drawBtn'),
    declineDrawBtn: document.getElementById('declineDrawBtn')
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
  let lastDrawOffer = null;
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

  function updateUrl(code, params) {
    try {
      const base = code ? '/corespon/' + code : '/corespon';
      window.history.replaceState(null, '', base + (code ? (params || '') : ''));
    } catch (error) {
      // history no disponible: no pasa nada
    }
  }

  // ?ver=1 (o ?espectador=1) abre la partida en modo solo lectura.
  function watchFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('ver') === '1' || params.get('ver') === 'true') return true;
    return params.get('espectador') === '1';
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
    el.leaveBtn.textContent = isSpectator ? 'Salir' : 'Abandonar';
    el.leaveBtn.title = isSpectator
      ? 'Dejar de ver la partida'
      : 'Abandonar la partida: cuenta como derrota';
    el.leaveBtn.setAttribute('aria-label', el.leaveBtn.title);
    el.lobbyBtn.hidden = isSpectator;
    lastDrawOffer = room.drawOffer || null;
    showGame();
    el.roomCode.textContent = room.code;
    el.waitingCode.textContent = room.code;
    updateUrl(room.code, isSpectator ? '?ver=1' : '');
    clearSelection();
    pendingPromotion = null;
    movePending = false;
    el.promotionOverlay.hidden = true;
    render();
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

    if (isSpectator && !over) {
      el.plazoCard.hidden = false;
      el.plazoIcon.textContent = '♟';
      el.plazoStatus.textContent = 'Turno de ' + playerName(room.state.turn);
      renderPlazoText();
      el.extendBtn.disabled = true;
      el.extendBtn.textContent = 'Solo lectura';
    } else if (isYou && !over) {
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

    // Tablas por acuerdo: proponer, aceptar o rechazar.
    const rival = other(myColor);
    const puedeProponer = !isSpectator && !over && !!myColor
      && !!(room.players[rival]);
    el.drawBtn.hidden = !puedeProponer;
    el.declineDrawBtn.hidden = true;

    if (puedeProponer) {
      if (room.drawOffer === myColor) {
        el.drawBtn.disabled = true;
        el.drawBtn.textContent = 'Tablas propuestas…';
      } else if (room.drawOffer === rival) {
        el.drawBtn.disabled = false;
        el.drawBtn.textContent = 'Aceptar tablas';
        el.declineDrawBtn.hidden = false;
      } else {
        el.drawBtn.disabled = false;
        el.drawBtn.textContent = 'Proponer tablas';
      }
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
    const rival = room.players[opponent];

    if (room.status.over) {
      el.statusText.textContent = resultInfo(room.status, opponentName).status;
      return;
    }

    if (!O.isConnected()) {
      el.statusText.textContent = 'Sin conexión. Reconectando…';
      return;
    }

    if (!rival) {
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

    if (!rival.joined) {
      const pending = document.createElement('span');
      pending.className = 'status-muted';
      pending.textContent = ' · ' + rival.name + ' aún no ha entrado';
      parts.push(pending);
    } else if (!rival.connected) {
      const offline = document.createElement('span');
      offline.className = 'status-muted';
      offline.textContent = ' · Rival sin conexión (la partida sigue)';
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
    // El plazo se muestra en la tarjeta de tiempo; estos nodos solo existen
    // en algunas versiones de la vista. Si no están, no hay nada que pintar,
    // pero no debe romper el resto del render (resultado, overlays, etc.).
    const rows = [];
    if (el.topClock) rows.push({ node: el.topClock, color: other(viewColor()) });
    if (el.bottomClock) rows.push({ node: el.bottomClock, color: viewColor() });
    if (!rows.length) return;

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
    el.resultLeaveBtn.textContent = 'Volver a la lista';

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
      case 'agreement':
        return {
          title: 'Tablas',
          text: 'Habéis acordado tablas.',
          status: 'Tablas por acuerdo mutuo.'
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

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      if (value === null || value === undefined || value === '') {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    } catch (error) {
      // Sin almacenamiento (modo privado): se sigue pudiendo jugar.
    }
  }

  /*
   * Clave personal por jugador, recordada en este dispositivo. Solo se pide
   * la primera vez: al elegir el nombre se rellena sola.
   */
  const PIN_KEY_PREFIX = 'corespon.pin.';

  function leerPin(nombre) {
    if (!nombre) return '';
    return readStorage(PIN_KEY_PREFIX + nombre) || '';
  }

  function guardarPin(nombre, pin) {
    if (!nombre || !pin) return;
    writeStorage(PIN_KEY_PREFIX + nombre, pin);
  }

  function borrarPin(nombre) {
    if (!nombre) return;
    writeStorage(PIN_KEY_PREFIX + nombre, null);
  }

  /*
   * Si el servidor rechaza la clave, la olvidamos en el dispositivo y
   * llevamos el foco al campo para que la vuelva a escribir.
   */
  function enfocarPin(error, nombre, input) {
    if (error !== 'pin_requerido' && error !== 'pin_incorrecto' && error !== 'pin_invalido') {
      return false;
    }
    if (error === 'pin_incorrecto') borrarPin(nombre);
    sincronizarPin('');
    if (input) input.focus();
    return true;
  }

  /*
   * La clave se escribe una sola vez, en cualquiera de los dos campos: se
   * mantienen sincronizados para que da igual dónde se ponga.
   */
  function sincronizarPin(valor) {
    const texto = String(valor || '');
    if (el.joinPin && el.joinPin.value !== texto) el.joinPin.value = texto;
    if (el.createPin && el.createPin.value !== texto) el.createPin.value = texto;
  }

  /*
   * Clave que se va a enviar: lo escrito en cualquiera de los campos y, si
   * los dos están vacíos, la recordada de ese nombre en este aparato.
   */
  function pinActual(nombre) {
    const escrito = (el.joinPin && el.joinPin.value.trim())
      || (el.createPin && el.createPin.value.trim())
      || '';
    if (escrito) return escrito;
    return leerPin(nombre);
  }

  /*
   * Rellena los tres desplegables del lobby conservando lo que ya estaba
   * elegido. La lista llega del servidor, así que un jugador añadido por el
   * administrador aparece sin recargar la página.
   */
  function fillPlayerSelects(nombres) {
    const lista = Array.isArray(nombres) && nombres.length ? nombres : PLAYERS;
    const selects = [
      { node: el.playerName, placeholder: '— Elige tu nombre —' },
      { node: el.rivalName, placeholder: '— Elige al rival —' },
      { node: el.joinName, placeholder: 'Mi nombre' }
    ];

    for (const { node, placeholder } of selects) {
      if (!node) continue;
      const anterior = node.value;
      node.replaceChildren();

      const vacio = document.createElement('option');
      vacio.value = '';
      vacio.textContent = placeholder;
      node.appendChild(vacio);

      for (const nombre of lista) {
        const opcion = document.createElement('option');
        opcion.value = nombre;
        opcion.textContent = nombre;
        node.appendChild(opcion);
      }

      if (anterior && lista.includes(anterior)) node.value = anterior;
    }

    // La clave recordada de cada jugador, sin que tengan que escribirla.
    sincronizarPin(leerPin(el.playerName.value.trim()) || leerPin(el.joinName.value.trim()));
  }

  async function loadPlayers() {
    let nombres = PLAYERS;
    try {
      const res = await fetch('/api/players');
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.players) && data.players.length) {
        nombres = data.players.map(p => p.nombre);
      }
    } catch (error) {
      // Sin conexión: se queda el roster de reserva.
    }
    fillPlayerSelects(nombres);
    return nombres;
  }

  // ==================== ADMINISTRACIÓN ====================

  function setAdminOpen(open) {
    el.adminPanel.hidden = !open;
    el.adminToggleBtn.setAttribute('aria-expanded', String(open));
    el.adminToggleBtn.textContent = open ? '⚙️ Administración ▲' : '⚙️ Administración';
    writeStorage(ADMIN_OPEN_KEY, open ? '1' : '');
  }

  function showAdminStatus(mensaje, tipo) {
    el.adminStatus.className = 'message ' + (tipo === 'error' ? 'message-error' : 'message-ok');
    el.adminStatus.textContent = mensaje;
    el.adminStatus.hidden = false;
  }

  async function addPlayer(nombre, token) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-admin-token'] = token;

    const res = await fetch('/api/tournament/players', {
      method: 'POST',
      headers,
      body: JSON.stringify({ nombre })
    });

    let data = null;
    try {
      data = await res.json();
    } catch (error) {
      data = null;
    }
    return { res, data };
  }

  function renderAdminPlayers(jugadores) {
    el.adminPlayers.replaceChildren();

    for (const jugador of jugadores) {
      const fila = document.createElement('div');
      fila.className = 'admin-player';

      const nombre = document.createElement('span');
      nombre.className = 'admin-player-name' + (jugador.activa ? '' : ' baja');
      nombre.textContent = jugador.nombre;

      const estado = document.createElement('span');
      estado.className = 'admin-player-estado ' + (jugador.activa ? 'activo' : 'inactivo');
      estado.textContent = jugador.activa ? 'Activo' : 'De baja';

      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'btn btn-ghost btn-sm';
      boton.textContent = jugador.activa ? 'Dar de baja' : 'Reactivar';
      boton.addEventListener('click', () => togglePlayerActiva(jugador));

      const clave = document.createElement('span');
      clave.className = 'admin-player-clave ' + (jugador.tieneClave ? 'ok' : 'no');
      clave.textContent = jugador.tieneClave ? 'Con clave' : 'Sin clave';

      fila.append(nombre, estado, clave, boton);

      // Clave personal del jugador: asignar o borrar (nunca se muestra).
      const pinWrap = document.createElement('div');
      pinWrap.className = 'admin-player-pin';

      const pinInput = document.createElement('input');
      pinInput.type = 'password';
      pinInput.inputMode = 'numeric';
      pinInput.maxLength = 6;
      pinInput.autocomplete = 'off';
      pinInput.className = 'admin-pin-input';
      pinInput.placeholder = jugador.tieneClave ? 'Nueva clave' : 'Clave (4-6)';
      pinInput.setAttribute('aria-label', 'Clave de ' + jugador.nombre);

      const guardarClave = document.createElement('button');
      guardarClave.type = 'button';
      guardarClave.className = 'btn btn-ghost btn-sm';
      guardarClave.textContent = 'Guardar clave';
      guardarClave.addEventListener('click', () => guardarClaveJugador(jugador, pinInput.value));

      pinWrap.append(pinInput, guardarClave);

      if (jugador.tieneClave) {
        const quitarClave = document.createElement('button');
        quitarClave.type = 'button';
        quitarClave.className = 'btn btn-ghost btn-sm';
        quitarClave.textContent = 'Borrar clave';
        quitarClave.addEventListener('click', () => guardarClaveJugador(jugador, null));
        pinWrap.append(quitarClave);
      }

      fila.append(pinWrap);
      el.adminPlayers.appendChild(fila);
    }
  }

  /*
   * Asigna (pin = "1234") o borra (pin = null) la clave de un jugador.
   * Va siempre con el token de administración.
   */
  async function guardarClaveJugador(jugador, pin) {
    const token = el.adminToken ? el.adminToken.value.trim() : '';

    if (pin !== null) {
      const limpio = String(pin || '').trim();
      if (!/^[0-9]{4,6}$/.test(limpio)) {
        showAdminStatus('La clave debe tener de 4 a 6 dígitos.', 'error');
        return;
      }
      pin = limpio;
    }

    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-admin-token'] = token;

    try {
      const res = await fetch('/api/tournament/players/' + encodeURIComponent(jugador.id), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ pin })
      });

      let data = null;
      try {
        data = await res.json();
      } catch (error) {
        data = null;
      }

      if (res.status === 401) {
        showAdminStatus('Token incorrecto. Cópialo de Render → Environment → ADMIN_TOKEN.', 'error');
        return;
      }
      if (!data || !data.ok) {
        showAdminStatus((data && data.error) || 'No se pudo guardar la clave.', 'error');
        return;
      }

      showAdminStatus(
        jugador.nombre + ': clave ' + (pin ? 'guardada.' : 'borrada.'),
        'ok'
      );
      await loadAdminPlayers();
    } catch (error) {
      showAdminStatus('Error de red al guardar la clave.', 'error');
    }
  }

  /*
   * Cierra las sesiones abiertas: cambia los tokens de las partidas en curso
   * para que ninguna sesión antigua pueda seguir moviendo. Cada jugador
   * vuelve a entrar con su clave; no se pierde ninguna jugada.
   */
  /*
   * Alta de claves: estado de la ventana en la que se pueden registrar claves
   * nuevas. Cerrada por defecto, para que nadie reclame el nombre de otro.
   */
  async function peticionAdmin(url, opciones = {}) {
    const token = el.adminToken ? el.adminToken.value.trim() : '';
    const headers = Object.assign({}, opciones.headers || {});
    if (token) headers['x-admin-token'] = token;

    const res = await fetch(url, Object.assign({}, opciones, { headers }));

    let data = null;
    try {
      data = await res.json();
    } catch (error) {
      data = null;
    }
    return { res, data };
  }

  function textoRestante(hasta) {
    const ms = Math.max(0, Date.parse(hasta) - Date.now());
    const minutos = Math.round(ms / 60000);
    if (minutos < 60) return minutos + ' min';
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return horas + ' h' + (resto ? ' ' + resto + ' min' : '');
  }

  async function loadEnrollment() {
    if (!el.adminEnrollmentState) return;

    try {
      const { res, data } = await peticionAdmin('/api/admin/enrollment');

      if (res.status === 401) {
        el.adminEnrollmentState.textContent = 'Pega el token para ver el estado.';
        return;
      }
      if (!data || !data.ok) {
        el.adminEnrollmentState.textContent = 'No se pudo consultar el alta de claves.';
        return;
      }

      const faltan = data.sinClave === 0
        ? 'todos con clave'
        : data.sinClave + ' de ' + data.jugadores + ' sin clave';

      el.adminEnrollmentState.textContent = data.abierta
        ? 'Abierta · quedan ' + textoRestante(data.hasta) + ' · ' + faltan
        : 'Cerrada · ' + faltan;

      el.adminEnrollmentState.classList.toggle('abierta', !!data.abierta);
    } catch (error) {
      el.adminEnrollmentState.textContent = 'Error de red al consultar el alta.';
    }
  }

  async function setEnrollment(cuerpo, mensaje) {
    try {
      const { res, data } = await peticionAdmin('/api/admin/enrollment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo)
      });

      if (res.status === 401) {
        showAdminStatus('Token incorrecto. Cópialo de Render → Environment → ADMIN_TOKEN.', 'error');
        return;
      }
      if (!data || !data.ok) {
        showAdminStatus((data && data.error) || 'No se pudo cambiar el alta de claves.', 'error');
        return;
      }

      showAdminStatus(mensaje, 'ok');
      await loadEnrollment();
      await loadAdminPlayers();
    } catch (error) {
      showAdminStatus('Error de red al cambiar el alta de claves.', 'error');
    }
  }

  async function rotateSeats() {
    if (!window.confirm(
      '¿Cerrar las sesiones abiertas?\n\n'
      + 'Cada jugador tendrá que pulsar Entrar otra vez con su clave.\n'
      + 'No se pierde ninguna jugada ni el plazo de la partida.'
    )) return;

    const token = el.adminToken ? el.adminToken.value.trim() : '';
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-admin-token'] = token;

    try {
      const res = await fetch('/api/admin/rotate-seats', {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      });

      let data = null;
      try {
        data = await res.json();
      } catch (error) {
        data = null;
      }

      if (res.status === 401) {
        showAdminStatus('Token incorrecto. Cópialo de Render → Environment → ADMIN_TOKEN.', 'error');
        return;
      }
      if (!data || !data.ok) {
        showAdminStatus((data && data.error) || 'No se pudieron cerrar las sesiones.', 'error');
        return;
      }

      showAdminStatus(
        data.salas
          ? 'Sesiones cerradas en ' + data.salas + ' partida(s). Que cada jugador entre con su clave.'
          : 'No hay partidas abiertas que cerrar.',
        'ok'
      );
      await loadEnrollment();
    } catch (error) {
      showAdminStatus('Error de red al cerrar las sesiones.', 'error');
    }
  }

  async function loadAdminPlayers() {
    if (!el.adminPlayers) return;

    const token = el.adminToken ? el.adminToken.value.trim() : '';
    const headers = token ? { 'x-admin-token': token } : {};

    try {
      const res = await fetch('/api/tournament/players', { headers });

      if (res.status === 401) {
        el.adminPlayers.innerHTML = '<p class="empty">Pega el token para ver la lista.</p>';
        return;
      }

      const data = await res.json();
      if (!data || !data.ok) {
        el.adminPlayers.innerHTML = '<p class="empty">No se pudo cargar la lista.</p>';
        return;
      }

      renderAdminPlayers(Array.isArray(data.jugadores) ? data.jugadores : []);
    } catch (error) {
      el.adminPlayers.innerHTML = '<p class="empty">Error de red al cargar la lista.</p>';
    }
  }

  async function togglePlayerActiva(jugador) {
    const token = el.adminToken ? el.adminToken.value.trim() : '';
    const activa = !jugador.activa;
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-admin-token'] = token;

    try {
      const res = await fetch('/api/tournament/players/' + encodeURIComponent(jugador.id), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ activa })
      });

      let data = null;
      try {
        data = await res.json();
      } catch (error) {
        data = null;
      }

      if (res.status === 401) {
        showAdminStatus(
          'Token incorrecto. Cópialo de Render → Environment → ADMIN_TOKEN.',
          'error'
        );
        return;
      }

      if (!data || !data.ok) {
        showAdminStatus((data && data.error) || 'No se pudo cambiar el estado.', 'error');
        return;
      }

      showAdminStatus(
        `${jugador.nombre} ${activa ? 'reactivado' : 'de baja'}. El torneo pasa a `
        + `${data.torneo.numeroJugadores} jugadores y ${data.torneo.totalPartidas} partidas.`,
        'ok'
      );

      await loadAdminPlayers();
      await loadPlayers();
      await loadClasificacion();
    } catch (error) {
      showAdminStatus('Error de red al cambiar el estado.', 'error');
    }
  }

  function setupAdmin() {
    if (!el.adminForm || !el.adminToggleBtn || !el.adminPanel) return;

    const tokenGuardado = readStorage(ADMIN_TOKEN_KEY) || '';
    el.adminToken.value = tokenGuardado;

    const abierto = readStorage(ADMIN_OPEN_KEY);
    setAdminOpen(abierto === '1' || (abierto === null && tokenGuardado !== ''));

    el.adminToggleBtn.addEventListener('click', () => {
      const abrir = el.adminPanel.hidden;
      setAdminOpen(abrir);
      if (abrir) {
        loadAdminPlayers();
        loadEnrollment();
      }
    });

    el.adminToken.addEventListener('change', () => {
      loadAdminPlayers();
      loadEnrollment();
    });

    if (el.adminRotateBtn) el.adminRotateBtn.addEventListener('click', rotateSeats);

    if (el.adminEnroll2Btn) {
      el.adminEnroll2Btn.addEventListener('click', () =>
        setEnrollment({ abrir: true, horas: 2 }, 'Alta de claves abierta 2 horas.'));
    }
    if (el.adminEnroll24Btn) {
      el.adminEnroll24Btn.addEventListener('click', () =>
        setEnrollment({ abrir: true, horas: 24 }, 'Alta de claves abierta 24 horas.'));
    }
    if (el.adminEnrollCloseBtn) {
      el.adminEnrollCloseBtn.addEventListener('click', () =>
        setEnrollment({ abrir: false }, 'Alta de claves cerrada.'));
    }

    if (!el.adminPanel.hidden) {
      loadAdminPlayers();
      loadEnrollment();
    }

    el.adminForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      const nombre = el.adminPlayerName.value.trim();
      const token = el.adminToken.value.trim();

      if (!nombre) {
        showAdminStatus('Escribe el nombre del jugador.', 'error');
        el.adminPlayerName.focus();
        return;
      }

      writeStorage(ADMIN_TOKEN_KEY, token);
      el.adminAddBtn.disabled = true;

      try {
        const { res, data } = await addPlayer(nombre, token);

        if (res.status === 201 && data && data.ok) {
          const { torneo, jugador } = data;
          showAdminStatus(
            `${jugador.nombre} añadido. El torneo pasa a ${torneo.numeroJugadores} jugadores `
            + `y ${torneo.totalPartidas} partidas.`,
            'ok'
          );
          el.adminPlayerName.value = '';
          await loadAdminPlayers();
          await loadPlayers();
          await loadClasificacion();
          return;
        }

        if (res.status === 401) {
          showAdminStatus(
            'Token incorrecto. Cópialo de Render → Environment → ADMIN_TOKEN.',
            'error'
          );
          return;
        }

        showAdminStatus((data && data.error) || 'No se pudo añadir el jugador.', 'error');
      } catch (error) {
        showAdminStatus('Error de red al añadir el jugador.', 'error');
      } finally {
        el.adminAddBtn.disabled = false;
      }
    });
  }

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

        const jugadores = document.createElement('div');
        jugadores.className = 'partida-players';
        const blancas = document.createElement('strong');
        blancas.textContent = p.blancas;
        const negras = document.createElement('strong');
        negras.textContent = p.negras;
        jugadores.append(blancas, document.createTextNode(' vs '), negras);

        // Turno según el servidor: 'white' | 'black'.
        const enTurno = p.turno === 'white' ? p.blancas : p.negras;
        const turno = document.createElement('span');
        turno.className = 'turno-badge';
        turno.title = 'Le toca mover';
        turno.textContent = '▶ ' + enTurno;

        const plazo = document.createElement('div');
        plazo.className = 'partida-plazo';
        const plazoBadge = document.createElement('span');
        plazoBadge.className = 'plazo-badge';
        plazoBadge.title = 'Plazo hasta ' + formatFecha(p.plazoHasta);
        plazoBadge.textContent = '⏰ ' + formatFecha(p.plazoHasta);
        plazo.appendChild(plazoBadge);

        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'btn btn-primary btn-sm ver-partida';
        boton.dataset.code = p.roomCode;
        boton.textContent = 'Ver partida';
        boton.addEventListener('click', () => {
          const seleccionado = el.playerName.value;
          if (p.blancas === seleccionado || p.negras === seleccionado) {
            joinViaCode(p.roomCode, seleccionado);
          } else {
            window.location.href = '/corespon/' + p.roomCode + '?ver=1';
          }
        });

        item.append(jugadores, turno, plazo, boton);
        el.partidasList.appendChild(item);
      }
    } catch (error) {
      console.error('Error cargando partidas:', error);
    }
  }

  /*
   * Info del torneo (formato, jugadores y partidas programadas).
   * Es opcional: si el endpoint no responde, la clasificación se ve igual.
   */
  async function loadTorneoInfo() {
    try {
      const res = await fetch('/api/tournament');
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch (error) {
      return null;
    }
  }

  function renderTorneoBanner(info) {
    if (!info) return null;

    const contenedor = document.createElement('div');
    contenedor.className = 'torneo-info';

    const banner = document.createElement('div');
    banner.className = 'torneo-banner';

    const titulo = document.createElement('strong');
    titulo.className = 'torneo-titulo';
    titulo.textContent = '♟️ Torneo round-robin';
    banner.appendChild(titulo);

    const detalle = document.createElement('span');
    detalle.className = 'torneo-detalle';
    detalle.textContent = info.descripcion || '';
    banner.appendChild(detalle);

    contenedor.appendChild(banner);

    const stats = document.createElement('div');
    stats.className = 'torneo-stats';
    const partes = [
      `👥 ${info.numeroJugadores} jugadores`,
      `📊 ${info.partidasJugadas ?? 0}/${info.totalPartidas} partidas jugadas`,
      `🔄 ${info.partidasPorPareja} partidas por pareja`
    ];
    for (const texto of partes) {
      const span = document.createElement('span');
      span.textContent = texto;
      stats.appendChild(span);
    }
    contenedor.appendChild(stats);

    return contenedor;
  }

  async function loadClasificacion() {
    try {
      const [res, torneoInfo] = await Promise.all([
        fetch('/api/classification'),
        loadTorneoInfo()
      ]);
      const data = await res.json();
      if (!data.ok) {
        el.clasificacionList.innerHTML = '<p class="empty">No se pudo cargar la clasificación.</p>';
        return;
      }

      const filas = Array.isArray(data.clasificacion) ? data.clasificacion : [];
      el.clasificacionList.replaceChildren();

      const banner = renderTorneoBanner(torneoInfo);
      if (banner) el.clasificacionList.appendChild(banner);

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
      for (const label of ['Jugador', 'Rating', 'P', 'V', 'E', 'D']) {
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
          fila.rating,
          fila.partidas,
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
    sincronizarPin(leerPin(name));
    el.joinForm.requestSubmit();
  }

  async function watchGame(code) {
    isSpectator = true;
    myColor = null;
    orientation = 'white';
    setBusy(true);
    clearLobbyError();

    try {
      const response = await O.watch(code);
      setBusy(false);
      if (!response.ok) {
        isSpectator = false;
        showLobby();
        el.codeInput.value = code;
        showLobbyError(errorText(response.error));
        return;
      }
      room = response.room;
      enterGame();
      showToast('Estás viendo la partida como espectador');
    } catch (error) {
      setBusy(false);
      isSpectator = false;
      showLobbyError('Error de conexión con el servidor.');
    }
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

    // Si falta la clave (o el alta está cerrada), el evento 'pin-required' ya
    // ha dejado el lobby listo: código, nombre y foco en el campo de la clave.
    if (esErrorDeClave(response.error)) return;

    showToast(errorText(response.error), 'error');
  }

  async function handleCreate() {
    if (busy) return;
    const name = el.playerName.value;
    const rival = el.rivalName.value;
    const color = el.playerColor.value === 'black' ? 'black' : 'white';
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

    const pin = pinActual(name);

    try {
      const res = await fetch('/api/partidas/invitar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jugador: name, rival, color, pin })
      });
      const data = await res.json();
      setBusy(false);

      if (!data.ok) {
        enfocarPin(data.error, name, el.createPin);
        showLobbyError(ERRORS[data.error] || data.error || 'No se pudo crear la sala.');
        return;
      }

      guardarPin(name, pin);

      // Unirse a la sala por socket con el nombre propio
      const joined = await O.joinRoom(data.room.code, name, pin);
      if (!joined.ok) {
        enfocarPin(joined.error, name, el.createPin);
        showLobbyError(errorText(joined.error));
        return;
      }

      // El color real lo decide el asiento ocupado (también si la sala ya
      // existía y se creó en orden inverso).
      myColor = joined.color;
      orientation = joined.color;
      room = joined.room;
      enterGame();
      showToast(data.existing
        ? 'Ya teníais una partida abierta: se reutiliza la sala.'
        : 'Sala creada. El rival recibirá una invitación por Telegram.');
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
    if (!name) {
      showLobbyError('Elige tu nombre para entrar.');
      return;
    }
    const pin = pinActual(name);
    setBusy(true);
    clearLobbyError();

    try {
      const response = await O.joinRoom(code, name, pin);
      setBusy(false);

      if (!response.ok) {
        enfocarPin(response.error, name, el.joinPin);
        showLobbyError(errorText(response.error));
        return;
      }

      guardarPin(name, pin);
      myColor = response.color;
      orientation = response.color;
      room = response.room;
      enterGame();
      showToast(response.pinGuardado
        ? 'Clave guardada para ' + name
        : (response.resumed ? 'Partida recuperada' : 'Te has unido a la sala'));
    } catch (error) {
      setBusy(false);
      showLobbyError('Error de conexión con el servidor.');
    }
  }

  async function leaveGame(confirmFirst, options = {}) {
    const resign = options.resign !== false;

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
    const rival = room.players[opponent];
    const inProgress = !room.status.over
      && !!room.players[myColor] && !!rival
      && room.players[myColor].joined && rival.joined;
    const over = !!room.status.over;

    if (confirmFirst && inProgress && resign) {
      const confirmed = window.confirm(
        '¿Abandonar la partida? Se contará como derrota. ' +
        'Si solo quieres dejarla para luego, cierra la pestaña: la partida se guarda.'
      );
      if (!confirmed) return;
    }

    await O.leaveRoom({ resign });
    room = null;
    myColor = null;
    pendingPromotion = null;
    rematchPending = false;
    movePending = false;
    clearSelection();
    showLobby();
    updateUrl(null);

    if (inProgress && resign) {
      showToast('Has abandonado: la partida queda en tu contra.');
    } else if (over) {
      showToast('Has vuelto a la lista.');
    } else {
      showToast('Partida guardada. Puedes volver cuando quieras.');
    }
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
    if (!isSpectator && payload.drawOffer && payload.drawOffer !== myColor
        && payload.drawOffer !== lastDrawOffer) {
      showToast('Tu rival propone tablas');
    }
    lastDrawOffer = payload.drawOffer || null;
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

  // La partida se canceló desde administración.
  O.on('closed', () => {
    room = null;
    myColor = null;
    pendingPromotion = null;
    rematchPending = false;
    movePending = false;
    clearSelection();
    O.clearSession();
    showLobby();
    updateUrl(null);
    showToast('La partida se ha cancelado.');
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

  /*
   * La sesión guardada ya no vale (por ejemplo tras cerrar las sesiones
   * abiertas) o el servidor pide la clave: volvemos al lobby con el código y
   * el nombre puestos para que solo tenga que confirmar.
   */
  /*
   * Errores que se resuelven escribiendo la clave personal en el lobby.
   */
  const ERRORES_CLAVE = ['pin_requerido', 'pin_incorrecto', 'pin_invalido', 'alta_cerrada'];

  function esErrorDeClave(error) {
    return ERRORES_CLAVE.indexOf(error) !== -1;
  }

  O.on('pin-required', (payload) => {
    // Este evento puede llegar mientras la página se está reenganchando
    // (busy), así que no se descarta: prepara el lobby igualmente.
    room = null;
    myColor = null;
    showLobby();
    updateUrl(null);

    const error = (payload && payload.error) || 'pin_requerido';
    const name = (payload && payload.name) || '';
    if (payload && payload.code) el.codeInput.value = payload.code;
    if (name && el.joinName) {
      el.joinName.value = name;
      sincronizarPin(leerPin(name));
    }

    showLobbyError(error === 'alta_cerrada'
      ? errorText('alta_cerrada')
      : 'Escribe tu clave para volver a la partida.');

    // El formulario está deshabilitado mientras se reanuda, así que el foco se
    // pone al terminar (el temporizador corre después del setBusy(false)).
    setTimeout(() => {
      if (el.joinPin && !el.joinPin.disabled) el.joinPin.focus();
    }, 0);
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
    sincronizarPin(leerPin(name));
  });

  el.rivalName.addEventListener('change', () => {
    const name = el.rivalName.value.trim();
    el.createBtn.disabled = !name;
  });

  el.joinName.addEventListener('change', () => {
    const name = el.joinName.value.trim();
    if (name) O.setName(name);
    sincronizarPin(leerPin(name));
  });

  // Escribir la clave en cualquiera de los dos campos rellena el otro.
  for (const campo of [el.joinPin, el.createPin]) {
    if (!campo) continue;
    campo.addEventListener('input', () => sincronizarPin(campo.value));
  }

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

  el.drawBtn.addEventListener('click', async () => {
    if (!room || !myColor) return;
    const esOfertaRival = !!room.drawOffer && room.drawOffer !== myColor;
    const respuesta = esOfertaRival
      ? await O.acceptDraw(room.code)
      : await O.offerDraw(room.code);
    if (!respuesta.ok) {
      showToast(errorText(respuesta.error), 'error');
      return;
    }
    showToast(esOfertaRival ? 'Tablas aceptadas' : 'Propuesta de tablas enviada');
  });

  el.declineDrawBtn.addEventListener('click', async () => {
    if (!room) return;
    const respuesta = await O.declineDraw(room.code);
    if (!respuesta.ok) {
      showToast(errorText(respuesta.error), 'error');
      return;
    }
    showToast('Has rechazado las tablas');
  });

  el.flipBtn.addEventListener('click', () => {
    orientation = orientation === 'white' ? 'black' : 'white';
    clearSelection();
    renderBoard();
  });

  el.lobbyBtn.addEventListener('click', () => leaveGame(false, { resign: false }));
  el.leaveBtn.addEventListener('click', () => leaveGame(true, { resign: true }));
  el.resultLeaveBtn.addEventListener('click', () => leaveGame(false, { resign: false }));
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

    // Roster de reserva al instante; luego se refresca desde el servidor.
    fillPlayerSelects(PLAYERS);

    const savedName = O.getName();
    if (savedName) {
      el.playerName.value = savedName;
      el.joinName.value = savedName;
    }

    loadPlayers().then((nombres) => {
      if (!savedName || !nombres.includes(savedName)) return;
      el.playerName.value = savedName;
      el.joinName.value = savedName;
    });

    setupAdmin();

    showLobby();

    const session = O.getSession();
    const urlCode = codeFromUrl();
    if (urlCode && watchFromUrl()) {
      el.codeInput.value = urlCode;
      watchGame(urlCode);
    } else if (session && session.code && (!urlCode || urlCode === session.code)) {
      attemptResume();
    } else if (urlCode) {
      el.codeInput.value = urlCode;
    }

    const online = O.isConnected();
    el.connectionBadge.classList.toggle('warn', !online);
  }

  init();
})();
