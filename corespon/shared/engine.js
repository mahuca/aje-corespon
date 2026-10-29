/*
 * Motor de ajedrez compartido (cliente + servidor).
 *
 * Funciona en Node (module.exports) y en el navegador (window.ChessEngine).
 * El servidor es la autoridad: valida cada jugada con validateAndApply().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChessEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 8;
  const FILES = 'abcdefgh';

  const WHITE_PIECES = {
    king: '♔', queen: '♕', rook: '♖',
    bishop: '♗', knight: '♘', pawn: '♙'
  };
  const BLACK_PIECES = {
    king: '♚', queen: '♛', rook: '♜',
    bishop: '♝', knight: '♞', pawn: '♟'
  };

  const INITIAL_POSITION = [
    ['♜', '♞', '♝', '♛', '♚', '♝', '♞', '♜'],
    ['♟', '♟', '♟', '♟', '♟', '♟', '♟', '♟'],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' '],
    ['♙', '♙', '♙', '♙', '♙', '♙', '♙', '♙'],
    ['♖', '♘', '♗', '♕', '♔', '♗', '♘', '♖']
  ];

  const KNIGHT_OFFSETS = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1]
  ];
  const KING_OFFSETS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1]
  ];
  const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ORTHOGONALS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  const PROMOTION_TYPES = ['queen', 'rook', 'bishop', 'knight'];
  const PIECE_VALUES = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
  const CAPTURE_ORDER = ['pawn', 'knight', 'bishop', 'rook', 'queen'];
  const CAPTURE_NAMES = {
    pawn: 'peones', knight: 'caballos', bishop: 'alfiles',
    rook: 'torres', queen: 'damas', king: 'reyes'
  };
  const PIECE_NAMES = {
    pawn: 'peón', knight: 'caballo', bishop: 'alfil',
    rook: 'torre', queen: 'dama', king: 'rey'
  };
  const NOTATION_LETTERS = {
    king: 'R', queen: 'D', rook: 'T', bishop: 'A', knight: 'C', pawn: ''
  };

  // ==================== AYUDANTES ====================

  function cloneBoard(board) {
    return board.map(row => row.slice());
  }

  function cloneState(state) {
    return {
      board: cloneBoard(state.board),
      turn: state.turn,
      kingMoved: { white: !!state.kingMoved.white, black: !!state.kingMoved.black },
      rookMoved: {
        white: {
          kingside: !!state.rookMoved.white.kingside,
          queenside: !!state.rookMoved.white.queenside
        },
        black: {
          kingside: !!state.rookMoved.black.kingside,
          queenside: !!state.rookMoved.black.queenside
        }
      },
      epTarget: state.epTarget ? { ...state.epTarget } : null,
      lastMove: state.lastMove
        ? { from: state.lastMove.from.slice(), to: state.lastMove.to.slice() }
        : null,
      captured: {
        white: (state.captured && state.captured.white ? state.captured.white : []).slice(),
        black: (state.captured && state.captured.black ? state.captured.black : []).slice()
      },
      halfmove: Number.isInteger(state.halfmove) ? state.halfmove : 0,
      fullmove: Number.isInteger(state.fullmove) ? state.fullmove : 1
    };
  }

  function newState() {
    return {
      board: cloneBoard(INITIAL_POSITION),
      turn: 'white',
      kingMoved: { white: false, black: false },
      rookMoved: {
        white: { kingside: false, queenside: false },
        black: { kingside: false, queenside: false }
      },
      epTarget: null,
      lastMove: null,
      captured: { white: [], black: [] },
      halfmove: 0,
      fullmove: 1
    };
  }

  function colorOf(piece) {
    if (!piece || piece === ' ') return null;
    if (Object.values(WHITE_PIECES).includes(piece)) return 'white';
    if (Object.values(BLACK_PIECES).includes(piece)) return 'black';
    return null;
  }

  function typeOf(piece) {
    if (!piece || piece === ' ') return null;
    for (const [type, symbol] of Object.entries(WHITE_PIECES)) {
      if (symbol === piece) return type;
    }
    for (const [type, symbol] of Object.entries(BLACK_PIECES)) {
      if (symbol === piece) return type;
    }
    return null;
  }

  function pieceFor(type, color) {
    return color === 'white' ? WHITE_PIECES[type] : BLACK_PIECES[type];
  }

  function other(color) {
    return color === 'white' ? 'black' : 'white';
  }

  function inside(row, col) {
    return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
  }

  function squareName(row, col) {
    return FILES[col] + (SIZE - row);
  }

  // ==================== REY, ATAQUES Y JAQUE ====================

  function findKing(board, color) {
    const king = pieceFor('king', color);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === king) return { row: r, col: c };
      }
    }
    return null;
  }

  function isAttacked(board, row, col, byColor) {
    // Peones
    const pawnDir = byColor === 'white' ? 1 : -1;
    const pawn = pieceFor('pawn', byColor);
    for (const dc of [-1, 1]) {
      const r = row + pawnDir;
      const c = col + dc;
      if (inside(r, c) && board[r][c] === pawn) return true;
    }

    // Caballos
    const knight = pieceFor('knight', byColor);
    for (const [dr, dc] of KNIGHT_OFFSETS) {
      const r = row + dr;
      const c = col + dc;
      if (inside(r, c) && board[r][c] === knight) return true;
    }

    // Rey
    const king = pieceFor('king', byColor);
    for (const [dr, dc] of KING_OFFSETS) {
      const r = row + dr;
      const c = col + dc;
      if (inside(r, c) && board[r][c] === king) return true;
    }

    // Deslizantes
    const rook = pieceFor('rook', byColor);
    const queen = pieceFor('queen', byColor);
    const bishop = pieceFor('bishop', byColor);

    for (const [dr, dc] of ORTHOGONALS) {
      let r = row + dr;
      let c = col + dc;
      while (inside(r, c)) {
        const p = board[r][c];
        if (p !== ' ') {
          if (p === rook || p === queen) return true;
          break;
        }
        r += dr;
        c += dc;
      }
    }

    for (const [dr, dc] of DIAGONALS) {
      let r = row + dr;
      let c = col + dc;
      while (inside(r, c)) {
        const p = board[r][c];
        if (p !== ' ') {
          if (p === bishop || p === queen) return true;
          break;
        }
        r += dr;
        c += dc;
      }
    }

    return false;
  }

  function isInCheck(board, color) {
    const king = findKing(board, color);
    if (!king) return false;
    return isAttacked(board, king.row, king.col, other(color));
  }

  // ==================== GENERACIÓN DE JUGADAS ====================

  function pseudoMoves(board, row, col, ctx) {
    const piece = board[row][col];
    const type = typeOf(piece);
    const color = colorOf(piece);
    if (!piece || piece === ' ' || !type) return [];

    const moves = [];
    const add = (r, c, capture, special) => {
      moves.push({ row: r, col: c, capture: !!capture, special: special || null });
    };

    if (type === 'pawn') {
      const dir = color === 'white' ? -1 : 1;
      const startRow = color === 'white' ? 6 : 1;
      const promoRow = color === 'white' ? 0 : 7;

      const oneR = row + dir;
      if (inside(oneR, col) && board[oneR][col] === ' ') {
        add(oneR, col, false, oneR === promoRow ? 'promotion' : null);
        const twoR = row + 2 * dir;
        if (row === startRow && board[twoR][col] === ' ') {
          add(twoR, col, false, 'double');
        }
      }

      for (const dc of [-1, 1]) {
        const r = row + dir;
        const c = col + dc;
        if (!inside(r, c)) continue;
        const target = board[r][c];
        if (target !== ' ' && colorOf(target) !== color) {
          add(r, c, true, r === promoRow ? 'promotion' : null);
        }
        // Al paso
        if (ctx && ctx.epTarget && ctx.epTarget.row === r && ctx.epTarget.col === c) {
          add(r, c, true, 'enpassant');
        }
      }
    }

    if (type === 'knight') {
      for (const [dr, dc] of KNIGHT_OFFSETS) {
        const r = row + dr;
        const c = col + dc;
        if (!inside(r, c)) continue;
        const target = board[r][c];
        if (target === ' ') add(r, c, false, null);
        else if (colorOf(target) !== color) add(r, c, true, null);
      }
    }

    if (type === 'king') {
      for (const [dr, dc] of KING_OFFSETS) {
        const r = row + dr;
        const c = col + dc;
        if (!inside(r, c)) continue;
        const target = board[r][c];
        if (target === ' ') add(r, c, false, null);
        else if (colorOf(target) !== color) add(r, c, true, null);
      }

      // Enroque
      const homeRow = color === 'white' ? 7 : 0;
      if (row === homeRow && col === 4 && !ctx.kingMoved[color]
          && !isInCheck(board, color)) {
        const enemy = other(color);

        if (!ctx.rookMoved[color].kingside
            && board[homeRow][5] === ' ' && board[homeRow][6] === ' '
            && board[homeRow][7] === pieceFor('rook', color)
            && !isAttacked(board, homeRow, 5, enemy)
            && !isAttacked(board, homeRow, 6, enemy)) {
          add(homeRow, 6, false, 'castling');
        }

        if (!ctx.rookMoved[color].queenside
            && board[homeRow][1] === ' ' && board[homeRow][2] === ' '
            && board[homeRow][3] === ' '
            && board[homeRow][0] === pieceFor('rook', color)
            && !isAttacked(board, homeRow, 3, enemy)
            && !isAttacked(board, homeRow, 2, enemy)) {
          add(homeRow, 2, false, 'castling');
        }
      }
    }

    if (type === 'rook' || type === 'bishop' || type === 'queen') {
      const dirs = [];
      if (type === 'rook' || type === 'queen') dirs.push(...ORTHOGONALS);
      if (type === 'bishop' || type === 'queen') dirs.push(...DIAGONALS);

      for (const [dr, dc] of dirs) {
        let r = row + dr;
        let c = col + dc;
        while (inside(r, c)) {
          const target = board[r][c];
          if (target === ' ') {
            add(r, c, false, null);
          } else {
            if (colorOf(target) !== color) add(r, c, true, null);
            break;
          }
          r += dr;
          c += dc;
        }
      }
    }

    return moves;
  }

  function legalMovesFor(row, col, board, ctx) {
    const piece = board[row][col];
    const color = colorOf(piece);
    if (!piece || piece === ' ' || !color) return [];
    const moves = [];

    for (const mv of pseudoMoves(board, row, col, ctx)) {
      const test = cloneBoard(board);
      test[mv.row][mv.col] = piece;
      test[row][col] = ' ';

      if (mv.special === 'enpassant') {
        test[row][mv.col] = ' ';
      }

      if (mv.special === 'castling') {
        if (mv.col === 6) {
          test[row][5] = test[row][7];
          test[row][7] = ' ';
        } else if (mv.col === 2) {
          test[row][3] = test[row][0];
          test[row][0] = ' ';
        }
      }

      if (!isInCheck(test, color)) moves.push(mv);
    }
    return moves;
  }

  function generateAllMoves(board, ctx, color) {
    const moves = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const piece = board[r][c];
        if (piece === ' ' || colorOf(piece) !== color) continue;
        for (const mv of legalMovesFor(r, c, board, ctx)) {
          moves.push({ from: [r, c], to: [mv.row, mv.col], mv });
        }
      }
    }
    return moves;
  }

  function hasAnyLegalMove(board, ctx, color) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const piece = board[r][c];
        if (piece === ' ' || colorOf(piece) !== color) continue;
        if (legalMovesFor(r, c, board, ctx).length > 0) return true;
      }
    }
    return false;
  }

  // ==================== APLICAR JUGADAS ====================

  /**
   * Aplica una jugada legal y devuelve un estado NUEVO (no muta el original).
   * `move` es el objeto devuelto por legalMovesFor/generateAllMoves.
   */
  function applyMove(state, from, move, promotionType) {
    const next = cloneState(state);
    const [fromRow, fromCol] = from;
    const [toRow, toCol] = [move.row, move.col];
    const board = next.board;
    const piece = board[fromRow][fromCol];
    const color = colorOf(piece);
    const type = typeOf(piece);
    const target = board[toRow][toCol];

    // Captura (incluida al paso)
    if (move.special === 'enpassant') {
      const epPiece = board[fromRow][toCol];
      if (epPiece !== ' ') next.captured[color].push(typeOf(epPiece));
    } else {
      if (target !== ' ') next.captured[color].push(typeOf(target));
    }

    board[toRow][toCol] = piece;
    board[fromRow][fromCol] = ' ';

    if (move.special === 'enpassant') {
      board[fromRow][toCol] = ' ';
    }

    if (move.special === 'castling') {
      if (toCol === 6) {
        board[fromRow][5] = board[fromRow][7];
        board[fromRow][7] = ' ';
      } else if (toCol === 2) {
        board[fromRow][3] = board[fromRow][0];
        board[fromRow][0] = ' ';
      }
    }

    if (move.special === 'promotion') {
      const promo = PROMOTION_TYPES.includes(promotionType) ? promotionType : 'queen';
      board[toRow][toCol] = pieceFor(promo, color);
    }

    // Derechos de enroque
    if (type === 'king') next.kingMoved[color] = true;
    if (type === 'rook') {
      if (fromCol === 0) next.rookMoved[color].queenside = true;
      if (fromCol === 7) next.rookMoved[color].kingside = true;
    }
    // Si capturan una torre en su casilla inicial, se pierde ese enroque
    if (target !== ' ' && typeOf(target) === 'rook') {
      const capColor = colorOf(target);
      const homeRow = capColor === 'white' ? 7 : 0;
      if (toRow === homeRow && (toCol === 0 || toCol === 7)) {
        if (toCol === 0) next.rookMoved[capColor].queenside = true;
        if (toCol === 7) next.rookMoved[capColor].kingside = true;
      }
    }

    // Al paso
    next.epTarget = null;
    if (type === 'pawn' && Math.abs(toRow - fromRow) === 2) {
      next.epTarget = {
        row: (fromRow + toRow) / 2,
        col: fromCol,
        pawnRow: toRow,
        pawnCol: toCol
      };
    }

    // Reloj de 50 jugadas
    const isCapture = move.capture || move.special === 'enpassant';
    next.halfmove = (type === 'pawn' || isCapture) ? 0 : next.halfmove + 1;
    if (color === 'black') next.fullmove = next.fullmove + 1;

    next.lastMove = { from: [fromRow, fromCol], to: [toRow, toCol] };
    next.turn = other(next.turn);
    return next;
  }

  function validSquare(value) {
    return Array.isArray(value) && value.length === 2
      && Number.isInteger(value[0]) && Number.isInteger(value[1])
      && inside(value[0], value[1]);
  }

  function validState(state) {
    return !!(state && Array.isArray(state.board) && state.board.length === SIZE
      && state.board.every(row => Array.isArray(row) && row.length === SIZE)
      && (state.turn === 'white' || state.turn === 'black')
      && state.kingMoved && state.rookMoved && state.captured
      && (state.epTarget === null || (state.epTarget
        && Number.isInteger(state.epTarget.row)
        && Number.isInteger(state.epTarget.col))));
  }

  /**
   * Valida y aplica una jugada recibida de un cliente.
   * Devuelve { ok: true, state, move, status } o { ok: false, error }.
   */
  function validateAndApply(state, from, to, promotionType) {
    if (!validState(state)) return { ok: false, error: 'invalid_state' };
    if (!validSquare(from) || !validSquare(to)) return { ok: false, error: 'invalid_payload' };

    const [fromRow, fromCol] = from;
    const [toRow, toCol] = to;
    if (fromRow === toRow && fromCol === toCol) return { ok: false, error: 'invalid_move' };

    const piece = state.board[fromRow][fromCol];
    if (!piece || piece === ' ') return { ok: false, error: 'no_piece' };
    if (colorOf(piece) !== state.turn) return { ok: false, error: 'not_your_turn' };

    const legal = legalMovesFor(fromRow, fromCol, state.board, state)
      .find(mv => mv.row === toRow && mv.col === toCol);
    if (!legal) return { ok: false, error: 'illegal_move' };

    const promo = legal.special === 'promotion'
      ? (PROMOTION_TYPES.includes(promotionType) ? promotionType : 'queen')
      : null;

    const next = applyMove(state, from, legal, promo);
    const status = getStatus(next);

    const move = {
      from: [fromRow, fromCol],
      to: [toRow, toCol],
      special: legal.special,
      capture: legal.capture,
      promotion: promo,
      piece: { type: typeOf(piece), color: colorOf(piece) }
    };
    move.notation = notationFor(state, move, status);

    return { ok: true, state: next, move, status };
  }

  // ==================== ESTADO DE LA PARTIDA ====================

  function isInsufficientMaterial(board) {
    const pieces = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = board[r][c];
        if (p === ' ') continue;
        pieces.push({ type: typeOf(p), color: colorOf(p), row: r, col: c });
      }
    }
    const nonKings = pieces.filter(p => p.type !== 'king');
    if (nonKings.length === 0) return true;
    if (nonKings.length === 1) {
      return nonKings[0].type === 'bishop' || nonKings[0].type === 'knight';
    }
    if (nonKings.length === 2 && nonKings.every(p => p.type === 'bishop')
        && nonKings[0].color !== nonKings[1].color) {
      const a = nonKings[0];
      const b = nonKings[1];
      return (a.row + a.col) % 2 === (b.row + b.col) % 2;
    }
    return false;
  }

  function getStatus(state) {
    const inCheck = isInCheck(state.board, state.turn);
    const hasMoves = hasAnyLegalMove(state.board, state, state.turn);

    if (!hasMoves) {
      if (inCheck) {
        return {
          over: true, reason: 'checkmate', winner: other(state.turn), inCheck: true
        };
      }
      return { over: true, reason: 'stalemate', winner: null, inCheck: false };
    }

    if (isInsufficientMaterial(state.board)) {
      return { over: true, reason: 'insufficient', winner: null, inCheck };
    }

    if (state.halfmove >= 100) {
      return { over: true, reason: 'fifty-move', winner: null, inCheck };
    }

    return { over: false, reason: null, winner: null, inCheck };
  }

  // ==================== NOTACIÓN Y RESUMEN ====================

  function notationFor(stateBefore, move, status) {
    const to = move.to || [move.row, move.col];
    const piece = stateBefore.board[move.from[0]][move.from[1]];
    const type = typeOf(piece);
    if (move.special === 'castling') {
      return to[1] === 6 ? 'O-O' : 'O-O-O';
    }

    const letter = NOTATION_LETTERS[type] || '';
    let text = letter + squareName(move.from[0], move.from[1])
      + (move.capture ? 'x' : '-')
      + squareName(to[0], to[1]);

    if (move.special === 'promotion') {
      const promo = PROMOTION_TYPES.includes(move.promotion) ? move.promotion : 'queen';
      text += '=' + NOTATION_LETTERS[promo];
    }

    if (status) {
      if (status.over && status.reason === 'checkmate') text += '#';
      else if (status.inCheck) text += '+';
    }

    return text;
  }

  function capturedSummary(captured) {
    const counts = {};
    for (const type of captured || []) counts[type] = (counts[type] || 0) + 1;
    return CAPTURE_ORDER
      .filter(type => counts[type])
      .map(type => ({ type, count: counts[type], name: CAPTURE_NAMES[type] }));
  }

  function materialAdvantage(captured) {
    const value = color => (captured[color] || [])
      .reduce((sum, type) => sum + (PIECE_VALUES[type] || 0), 0);
    return value('white') - value('black');
  }

  return {
    SIZE,
    FILES,
    WHITE_PIECES,
    BLACK_PIECES,
    INITIAL_POSITION,
    PROMOTION_TYPES,
    PIECE_VALUES,
    CAPTURE_ORDER,
    CAPTURE_NAMES,
    PIECE_NAMES,
    NOTATION_LETTERS,
    newState,
    cloneState,
    cloneBoard,
    colorOf,
    typeOf,
    pieceFor,
    other,
    inside,
    squareName,
    findKing,
    isAttacked,
    isInCheck,
    pseudoMoves,
    legalMovesFor,
    generateAllMoves,
    hasAnyLegalMove,
    applyMove,
    validateAndApply,
    validSquare,
    validState,
    getStatus,
    isInsufficientMaterial,
    notationFor,
    capturedSummary,
    materialAdvantage
  };
});
