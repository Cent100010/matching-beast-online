'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: false },
  maxHttpBufferSize: 1e6,
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const socketSeats = new Map();

const ALLOWED_ACTIONS = new Set([
  'toggleSelectHand','handleDrawFromDeck','handleSelectStealMode','handleDrawFromGraveyard',
  'handlePickGraveyardCard','handleCancelGraveyardChoice','handleCancelStealMode','handleStealCard',
  'handleClubChooseEffect','handleClubDrawFromDeck','handleClubSelectStealMode','handleClubDrawFromGraveyard',
  'handleClubPickGraveyardCard','handleCancelClubGraveyardChoice','handleCancelClubStealMode','handleClubStealCard',
  'handleSelectClubDestroyTarget','handleGluttonySacrifice','handleSummonBeast','handleSummonPig',
  'handleSummonJoker','handleSelectGluttonyTarget','handleCancelGluttonySteal','handleGluttonyStealCard',
  'handleSelectAdventTarget','handleCancelAdventGraveyard','handlePickAdventGraveyardCard','handleSkipSummon',
  'selectAttacker','networkAttack','handleAttackDirect','handleSkipAttack'
]);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function cleanName(name, fallback = 'プレイヤー') {
  const value = String(name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return value || fallback;
}
function newRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 100; tries++) {
    let id = '';
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(id)) return id;
  }
  throw new Error('部屋番号を発行できませんでした。もう一度お試しください。');
}
function playersList(room) {
  return [...room.players.entries()]
    .map(([id, p]) => ({ id, name: p.name }))
    .sort((a, b) => a.id - b.id);
}
function emitRoomInfo(room) {
  io.to(room.id).emit('room-info', { roomId: room.id, players: playersList(room), started: room.started });
}
function safeStateForSeat(state, seat) {
  const copy = JSON.parse(JSON.stringify(state));
  // Hand identities are private. Opponents see only the same number of card backs.
  copy.players = (copy.players || []).map(player => {
    if (player.id !== seat) {
      player.hand = (player.hand || []).map(() => ({ suit: 'back', val: 0, id: 'hidden-hand-card' }));
    }
    return player;
  });
  // The browser receives only a deck count, never the deck order or card identities.
  delete copy.deck;
  return copy;
}
function detach(socket, reason = 'left') {
  const location = socketSeats.get(socket.id);
  if (!location) return;
  socketSeats.delete(socket.id);
  const room = rooms.get(location.roomId);
  if (!room) return;
  const seat = location.seat;
  if (seat === 0) {
    io.to(room.id).emit('room-closed', { roomId: room.id, reason });
    for (const player of room.players.values()) {
      socketSeats.delete(player.socketId);
      const peer = io.sockets.sockets.get(player.socketId);
      if (peer) peer.leave(room.id);
    }
    rooms.delete(room.id);
    return;
  }
  room.players.delete(seat);
  socket.leave(room.id);
  if (room.started) {
    io.to(room.hostId).emit('player-left', { roomId: room.id, seat, reason });
  } else {
    emitRoomInfo(room);
  }
}

io.on('connection', socket => {
  socket.on('create-room', payload => {
    try {
      if (socketSeats.has(socket.id)) detach(socket, 'replaced');
      const roomId = newRoomId();
      const name = cleanName(payload && payload.name, 'ホスト');
      const room = {
        id: roomId,
        hostId: socket.id,
        started: false,
        state: null,
        players: new Map([[0, { socketId: socket.id, name }]]),
      };
      rooms.set(roomId, room);
      socketSeats.set(socket.id, { roomId, seat: 0 });
      socket.join(roomId);
      socket.emit('room-created', { roomId, seat: 0, players: playersList(room) });
      emitRoomInfo(room);
    } catch (err) {
      socket.emit('room-error', { message: err.message || '部屋を作成できませんでした。' });
    }
  });

  socket.on('join-room', payload => {
    const roomId = String((payload && payload.roomId) || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room) return socket.emit('room-error', { message: 'その部屋番号は見つかりません。番号を確認してください。' });
    if (room.started) return socket.emit('room-error', { message: 'この部屋はすでに対戦中です。次の対戦用に新しい部屋を作ってください。' });
    if (socketSeats.has(socket.id)) detach(socket, 'replaced');
    let seat = -1;
    for (let i = 1; i < 4; i++) if (!room.players.has(i)) { seat = i; break; }
    if (seat < 0) return socket.emit('room-error', { message: 'この部屋は満員です（最大4人）。' });
    const name = cleanName(payload && payload.name, `プレイヤー${seat + 1}`);
    room.players.set(seat, { socketId: socket.id, name });
    socketSeats.set(socket.id, { roomId, seat });
    socket.join(roomId);
    socket.emit('room-joined', { roomId, seat, players: playersList(room) });
    emitRoomInfo(room);
  });

  socket.on('start-room', payload => {
    const location = socketSeats.get(socket.id);
    if (!location || location.seat !== 0) return socket.emit('room-error', { message: '対戦を開始できるのは部屋のホストだけです。' });
    const room = rooms.get(location.roomId);
    if (!room || room.id !== String((payload && payload.roomId) || '')) return;
    if (room.started) return socket.emit('room-error', { message: 'この部屋はすでに開始されています。' });
    room.started = true;
    io.to(room.id).emit('room-started', { roomId: room.id, players: playersList(room) });
  });

  socket.on('host-state', payload => {
    const location = socketSeats.get(socket.id);
    if (!location || location.seat !== 0) return;
    const room = rooms.get(location.roomId);
    if (!room || !room.started || !payload || payload.roomId !== room.id || !payload.state) return;
    room.state = payload.state;
    for (const [seat, player] of room.players.entries()) {
      if (seat === 0) continue; // Host already has the authoritative live state.
      const target = io.sockets.sockets.get(player.socketId);
      if (target) target.emit('room-state', { roomId: room.id, state: safeStateForSeat(room.state, seat) });
    }
  });

  socket.on('action-feedback', payload => {
    const location = socketSeats.get(socket.id);
    if (!location || location.seat !== 0) return;
    const room = rooms.get(location.roomId);
    if (!room || !room.started || !payload || payload.roomId !== room.id) return;
    const targetSeat = Number(payload.seat);
    const player = room.players.get(targetSeat);
    if (!player || targetSeat === 0) return;
    const target = io.sockets.sockets.get(player.socketId);
    if (target) target.emit('action-feedback', {
      roomId: room.id,
      seat: targetSeat,
      message: String(payload.message || '操作できませんでした。').slice(0, 500),
    });
  });

  socket.on('room-action', payload => {
    const location = socketSeats.get(socket.id);
    if (!location || location.seat === 0) return;
    const room = rooms.get(location.roomId);
    if (!room || !room.started || !payload || payload.roomId !== room.id) return;
    if (!ALLOWED_ACTIONS.has(payload.name)) return;
    if (!room.state || !room.state.players || room.state.turnIndex !== location.seat) return;
    const actor = room.state.players[location.seat];
    if (!actor || actor.isCPU || !actor.alive) return;
    io.to(room.hostId).emit('room-action', {
      roomId: room.id,
      seat: location.seat,
      name: payload.name,
      args: Array.isArray(payload.args) ? payload.args.slice(0, 5) : [],
    });
  });

  socket.on('leave-room', () => detach(socket, 'left'));
  socket.on('disconnect', () => detach(socket, 'disconnect'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`マッチングビースト online server listening on ${PORT}`);
});
