const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const COLORS = ['red', 'yellow', 'green', 'blue'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ---------- Deck ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck() {
  const deck = [];
  let id = 0;
  const add = (color, value) => deck.push({ id: id++, color, value });
  for (const color of COLORS) {
    add(color, '0');
    for (let n = 1; n <= 9; n++) { add(color, String(n)); add(color, String(n)); }
    for (const action of ['skip', 'reverse', 'draw2']) { add(color, action); add(color, action); }
  }
  for (let i = 0; i < 4; i++) { add('wild', 'wild'); add('wild', 'wild4'); }
  return shuffle(deck); // 108 cards
}

const isNumberCard = c => /^[0-9]$/.test(c.value);
const describe = c =>
  c.value === 'wild4' ? 'Wild Draw 4' : c.value === 'wild' ? 'Wild' : `${c.color} ${c.value}`;

function reshuffleIfNeeded(room) {
  if (room.deck.length === 0 && room.discard.length > 1) {
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = [top];
  }
}

// A player's "UNO" flag only matters while they hold exactly one card.
function syncUno(player) {
  if (player.hand.length !== 1) player.said = false;
}

function drawCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    reshuffleIfNeeded(room);
    if (room.deck.length === 0) break;
    player.hand.push(room.deck.pop());
  }
  syncUno(player);
}

// ---------- Rooms ----------
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const cleanName = n => String(n || '').trim().slice(0, 16) || 'Player';
const newPlayer = (id, name) => ({ id, name, hand: [], said: false, connected: true });
const roomOf = socket => rooms.get(socket.data.room);
const isMyTurn = (room, socket) =>
  !!room && room.status === 'playing' && room.players[room.turn]?.id === socket.id;

// Next connected player, moving `steps` times in the current direction.
function advance(room, from, steps) {
  const n = room.players.length;
  let idx = from;
  for (let s = 0; s < steps; s++) {
    do {
      idx = (idx + room.dir + n) % n;
    } while (!room.players[idx].connected && room.players.some(p => p.connected));
  }
  return idx;
}

function startGame(room) {
  room.deck = buildDeck();
  room.discard = [];
  room.dir = 1;
  room.winner = null;
  for (const p of room.players) {
    p.hand = [];
    p.said = false;
    for (let i = 0; i < 7; i++) p.hand.push(room.deck.pop());
  }
  // Starting card must be a number so no special effect fires at the start.
  const [first] = room.deck.splice(room.deck.findIndex(isNumberCard), 1);
  room.discard.push(first);
  room.currentColor = first.color;
  room.turn = Math.floor(Math.random() * room.players.length);
  room.status = 'playing';
  room.lastEvent = `Game started! First card: ${describe(first)}`;
  setFx(room, { type: 'deal' });
}

function publicState(room) {
  const nextI = room.status === 'playing' ? advance(room, room.turn, 1) : -1;
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      count: p.hand.length,
      said: p.said,
      connected: p.connected,
      isTurn: room.status === 'playing' && i === room.turn,
      isNext: i === nextI,
    })),
    top: room.discard[room.discard.length - 1] || null,
    color: room.currentColor,
    direction: room.dir,
    winner: room.winner,
    lastEvent: room.lastEvent,
    fx: room.fx || null,
  };
}

// Public state goes to the whole room; each hand goes only to its owner.
function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
  for (const p of room.players) io.to(p.id).emit('hand', p.hand);
}

// Records one visual event so every connected client can animate the same move.
function setFx(room, fx) {
  room.fxSeq = (room.fxSeq || 0) + 1;
  room.fx = { ...fx, id: room.fxSeq };
}

// ---------- Sockets ----------
io.on('connection', socket => {
  socket.on('create', ({ name } = {}, ack) => {
    const code = makeCode();
    const room = {
      code,
      status: 'lobby',
      hostId: socket.id,
      players: [newPlayer(socket.id, cleanName(name))],
      deck: [], discard: [], dir: 1, turn: 0,
      currentColor: null, winner: null,
      lastEvent: 'Waiting for players…',
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;
    ack?.({ ok: true, code });
    broadcast(room);
  });

  socket.on('join', ({ name, code } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return ack?.({ ok: false, error: 'Room not found.' });
    if (room.status === 'playing') return ack?.({ ok: false, error: 'Game already in progress.' });
    if (room.players.length >= MAX_PLAYERS) return ack?.({ ok: false, error: `Room is full (max ${MAX_PLAYERS}).` });
    const player = newPlayer(socket.id, cleanName(name));
    room.players.push(player);
    socket.join(room.code);
    socket.data.room = room.code;
    room.lastEvent = `${player.name} joined`;
    ack?.({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('start', () => {
    const room = roomOf(socket);
    if (!room || room.status === 'playing' || room.hostId !== socket.id) return;
    if (room.status === 'over') room.players = room.players.filter(p => p.connected);
    if (room.players.length < MIN_PLAYERS) {
      return socket.emit('error_msg', `Need at least ${MIN_PLAYERS} players to start.`);
    }
    startGame(room);
    broadcast(room);
  });

  socket.on('play', ({ cardId, chosenColor } = {}) => {
    const room = roomOf(socket);
    if (!isMyTurn(room, socket)) return socket.emit('error_msg', "It's not your turn.");
    const player = room.players[room.turn];

    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx < 0) return socket.emit('error_msg', 'That card is not in your hand.');
    const card = player.hand[idx];
    const top = room.discard[room.discard.length - 1];
    const playable = card.color === 'wild' || card.color === room.currentColor || card.value === top.value;
    if (!playable) return socket.emit('error_msg', "That card doesn't match.");
    if (card.color === 'wild' && !COLORS.includes(chosenColor)) {
      return socket.emit('error_msg', 'Pick a color for your wild card.');
    }

    player.hand.splice(idx, 1);
    room.discard.push(card);
    room.currentColor = card.color === 'wild' ? chosenColor : card.color;
    syncUno(player);

    if (player.hand.length === 0) {
      room.status = 'over';
      room.winner = player.name;
      room.lastEvent = `${player.name} wins!`;
      setFx(room, { type: 'play', playerId: player.id, card });
      return broadcast(room);
    }

    let steps = 1;
    let victimId = null;
    let drawn = 0;
    if (card.value === 'skip') {
      steps = 2;
    } else if (card.value === 'reverse') {
      room.dir *= -1;
      steps = room.players.length === 2 ? 2 : 1; // with 2 players, reverse acts like skip
    } else if (card.value === 'draw2' || card.value === 'wild4') {
      const victim = room.players[advance(room, room.turn, 1)];
      drawCards(room, victim, card.value === 'draw2' ? 2 : 4);
      victimId = victim.id;
      drawn = card.value === 'draw2' ? 2 : 4;
      steps = 2; // victim loses their turn
    }

    room.turn = advance(room, room.turn, steps);
    const colorNote = card.color === 'wild' ? ` (now ${room.currentColor})` : '';
    room.lastEvent = `${player.name} played ${describe(card)}${colorNote}`;
    setFx(room, { type: 'play', playerId: player.id, card, victimId, drawn });
    broadcast(room);
  });

  socket.on('draw', () => {
    const room = roomOf(socket);
    if (!isMyTurn(room, socket)) return socket.emit('error_msg', "It's not your turn.");
    const player = room.players[room.turn];
    drawCards(room, player, 1);
    room.lastEvent = `${player.name} drew a card`;
    setFx(room, { type: 'draw', playerId: player.id, drawn: 1 });
    room.turn = advance(room, room.turn, 1);
    broadcast(room);
  });

  socket.on('uno', () => {
    const room = roomOf(socket);
    const player = room?.players.find(p => p.id === socket.id);
    if (!room || room.status !== 'playing' || !player || player.hand.length !== 1) return;
    player.said = true;
    room.lastEvent = `${player.name} shouted UNO!`;
    setFx(room, { type: 'uno', playerId: player.id });
    broadcast(room);
  });

  socket.on('catch', targetId => {
    const room = roomOf(socket);
    if (!room || room.status !== 'playing') return;
    const catcher = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!catcher || !target || target.hand.length !== 1 || target.said) {
      return socket.emit('error_msg', 'Nothing to catch.');
    }
    drawCards(room, target, 2);
    room.lastEvent = `${catcher.name} caught ${target.name} forgetting UNO! +2 cards`;
    setFx(room, { type: 'draw', playerId: target.id, drawn: 2 });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    const leaver = room.players[idx];

    if (room.status === 'lobby') {
      room.players.splice(idx, 1);
    } else {
      leaver.connected = false; // keep the seat, skip them on their turns
    }

    if (!room.players.some(p => p.connected)) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players.find(p => p.connected).id;
    }

    if (room.status === 'playing') {
      if (room.players[room.turn] === leaver) {
        room.turn = advance(room, room.turn, 1);
      }
      if (room.players.filter(p => p.connected).length < MIN_PLAYERS) {
        room.status = 'over';
        room.winner = null;
        room.lastEvent = `${leaver.name} left. Not enough players to continue.`;
      } else {
        room.lastEvent = `${leaver.name} disconnected`;
      }
    } else {
      room.lastEvent = `${leaver.name} left the room`;
    }
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`UNO server running on port ${PORT}`);
});