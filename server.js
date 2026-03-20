/**
 * Beyond Kings' Conquest — Online Multiplayer Server
 * Run: node server.js
 * Deploy: Render
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],  // allow polling for Render proxy compatibility
  allowUpgrades: true,
});

// Health/wake ping — used by client to pre-warm the Render instance
app.get('/ping', (req, res) => res.json({ ok: true, t: Date.now() }));

// Serve the game client
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── LOBBY STATE ─────────────────────────────────────────────────────────────

const rooms = new Map();
// room = {
//   id, code, players: [socket, socket], factions: [null, null],
//   started: bool, gameMode: string, eventInterval: null
// }

const waitingQueue = []; // for public matchmaking

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getOrMakeRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      id: code, code,
      players: [],
      factions: [null, null],
      started: false,
      gameMode: 'vs',
    });
  }
  return rooms.get(code);
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.eventInterval) clearInterval(room.eventInterval);
  rooms.delete(code);
}

function roomPid(room, socket) {
  return room.players.indexOf(socket) + 1; // 1 or 2, 0 if not found
}

// ─── CONNECTION ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);
  let myRoom = null;
  let myPid = null; // 1 or 2

  // ── JOIN PUBLIC QUEUE ──────────────────────────────────────────────────────
  socket.on('joinPublic', ({ gameMode }) => {
    if (waitingQueue.length > 0) {
      // Match with waiting player
      const other = waitingQueue.shift();
      if (!other.connected) { waitingQueue.push(socket); return; }

      const code = makeRoomCode();
      const room = getOrMakeRoom(code);
      room.gameMode = gameMode || 'vs';

      room.players.push(other, socket);
      other.join(code);
      socket.join(code);
      myRoom = room;
      myPid = 2;

      const otherPid = 1;
      other._bkcRoom = code;
      other._bkcPid = otherPid;
      socket._bkcRoom = code;
      socket._bkcPid = myPid;

      // Tell each player who they are
      other.emit('matchFound', { code, pid: 1, gameMode: room.gameMode });
      socket.emit('matchFound', { code, pid: 2, gameMode: room.gameMode });
      console.log(`[~] Public match: room ${code}`);
    } else {
      waitingQueue.push(socket);
      socket._inQueue = true;
      socket.emit('waiting');
      console.log(`[~] ${socket.id} waiting in queue`);
    }
  });

  // ── CREATE PRIVATE ROOM ────────────────────────────────────────────────────
  socket.on('createRoom', ({ gameMode }) => {
    const code = makeRoomCode();
    const room = getOrMakeRoom(code);
    room.gameMode = gameMode || 'vs';
    room.players.push(socket);
    socket.join(code);
    myRoom = room;
    myPid = 1;
    socket._bkcRoom = code;
    socket._bkcPid = 1;
    socket.emit('roomCreated', { code, pid: 1, gameMode: room.gameMode });
    console.log(`[+] Room ${code} created by ${socket.id}`);
  });

  // ── JOIN PRIVATE ROOM ──────────────────────────────────────────────────────
  socket.on('joinRoom', ({ code, gameMode }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', { msg: 'Room not found' }); return; }
    if (room.players.length >= 2) { socket.emit('error', { msg: 'Room is full' }); return; }
    if (room.started) { socket.emit('error', { msg: 'Game already started' }); return; }

    room.players.push(socket);
    socket.join(code.toUpperCase());
    myRoom = room;
    myPid = 2;
    socket._bkcRoom = code.toUpperCase();
    socket._bkcPid = 2;

    // Tell P1 someone joined
    room.players[0].emit('opponentJoined');
    // Tell P2 they're in
    socket.emit('roomJoined', { code: code.toUpperCase(), pid: 2, gameMode: room.gameMode });
    console.log(`[+] ${socket.id} joined room ${code.toUpperCase()}`);
  });

  // ── FACTION HOVER (preview while browsing) ───────────────────────────────
  socket.on('factionHover', ({ factionId }) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room) return;
    const pid = socket._bkcPid;
    const other = room.players.find(p => p !== socket);
    if (other) other.emit('opponentHover', { pid, factionId });
  });

  // ── CANCEL SEARCH ─────────────────────────────────────────────────────────
  socket.on('cancelSearch', () => {
    // Remove from public queue if waiting
    const qi = waitingQueue.indexOf(socket);
    if (qi !== -1) { waitingQueue.splice(qi, 1); socket._inQueue = false; }
    // Clean up any created room that hasn't started
    const room = rooms.get(socket._bkcRoom);
    if (room && !room.started && room.players.length === 1) {
      cleanupRoom(room.code);
      socket._bkcRoom = null;
    }
    console.log(`[~] ${socket.id} cancelled search`);
  });

  // ── FACTION SELECTED ──────────────────────────────────────────────────────
  // Relay faction choice to opponent so they can see it
  socket.on('factionSelected', ({ factionId }) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room) return;
    const pid = socket._bkcPid;
    room.factions[pid - 1] = factionId;
    // Tell the other player
    const other = room.players.find(p => p !== socket);
    if (other) other.emit('opponentFaction', { pid, factionId });
    // If both have chosen, tell both to start
    if (room.factions[0] && room.factions[1]) {
      const seed = Math.floor(Math.random() * 1e9);
      room.seed = seed;
      room.factionsLocked = true; // factions chosen — ready for ready-state
      io.to(room.code).emit('startGame', {
        p1Faction: room.factions[0],
        p2Faction: room.factions[1],
        seed,
        gameMode: room.gameMode,
      });
      // room.started stays false until BOTH players click Ready
      console.log(`[>] Room ${room.code} factions locked (seed ${seed})`);
    }
  });

  // ── GAME INPUT RELAY ──────────────────────────────────────────────────────
  // All game actions from a player are relayed to their opponent verbatim.
  // Actions: spawn | buyUpgrade | activateBuff | toggleWorkerMid | spawnSpy
  //          voteMoveCursor | voteForEvent
  socket.on('gameAction', (action) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room || !room.started) return;
    const other = room.players.find(p => p !== socket);
    if (other) other.emit('remoteAction', action);
  });

  // P1 authoritative state → P2 only (server just relays, never touches it)
  socket.on('stateUpdate', (data) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room || !room.started || socket._bkcPid !== 1) return;
    const p2 = room.players.find(p => p !== socket);
    if (p2 && p2.connected) p2.emit('stateUpdate', data);
  });

  // Ready-state relay: both players must send 'playerReady' before game starts
  socket.on('playerReady', () => {
    const room = rooms.get(socket._bkcRoom);
    // Guard: factions must be locked, game must not have already started
    if (!room || !room.factionsLocked || room.started) return;
    if (!room.ready) room.ready = new Set();
    room.ready.add(socket._bkcPid);
    // Tell the other player their opponent is ready
    const other = room.players.find(p => p !== socket);
    if (other) other.emit('opponentReady', { pid: socket._bkcPid });
    // Both ready → flip started and launch
    if (room.ready.size === 2) {
      room.started = true;
      io.to(room.code).emit('bothReady');
      console.log(`[>] Room ${room.code} both ready — game starting`);
    }
  });

  // Faction cursor sync — relay W/S cursor position to opponent during faction select
  socket.on('factionCursor', ({ cursorIdx }) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room) return;
    const other = room.players.find(p => p !== socket);
    if (other) other.emit('opponentFactionCursor', { pid: socket._bkcPid, cursorIdx });
  });

  // ── EVENT SYNC ────────────────────────────────────────────────────────────
  // Server picks which random event fires (so both clients get same event).
  // Client tells server "time for an event", server picks and broadcasts.
  socket.on('requestEvent', ({ elapsed, p1hp, p2hp, midOwner }) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room || !room.started) return;
    // Only respond to P1's request to avoid double-firing
    if (socket._bkcPid !== 1) return;

    const eventId = pickEvent({ elapsed, p1hp, p2hp, midOwner });
    const nextDelay = 90 + Math.random() * 60;
    io.to(room.code).emit('fireEvent', { eventId, nextDelay });
    console.log(`[E] Room ${room.code}: event ${eventId}`);
  });

  // Vote tie-break: server resolves ties
  socket.on('voteResult', ({ candidates, votes }) => {
    const room = rooms.get(socket._bkcRoom);
    if (!room || !room.started) return;
    if (socket._bkcPid !== 1) return; // only P1 sends this
    let winner;
    if (votes[0] > votes[1]) winner = candidates[0];
    else if (votes[1] > votes[0]) winner = candidates[1];
    else winner = candidates[Math.floor(Math.random() * 2)];
    io.to(room.code).emit('voteResolved', { winner });
  });

  // ── ROGUE UNIT SPAWN POSITION ─────────────────────────────────────────────
  // Server picks X position so both clients match
  socket.on('requestRogueSpawn', () => {
    const room = rooms.get(socket._bkcRoom);
    if (!room || !room.started || socket._bkcPid !== 1) return;
    const spawnX = 0.3 + Math.random() * 0.4; // 0.3–0.7 of canvas width (normalised)
    io.to(room.code).emit('rogueSpawnPos', { spawnX });
  });

  // ── REJOIN MATCH (during grace period) ─────────────────────────────────────
  socket.on('rejoinMatch', ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room._graceTimer) { socket.emit('error', { msg: 'Room expired' }); return; }
    const dcPid = room._disconnectedPid;
    if (!dcPid) { socket.emit('error', { msg: 'No slot to rejoin' }); return; }

    // Clear grace timer — player is back
    clearTimeout(room._graceTimer);
    room._graceTimer = null;
    room._disconnectedPid = null;

    // Swap the disconnected socket for the new one
    room.players[dcPid - 1] = socket;
    socket.join(code);
    socket._bkcRoom = code;
    socket._bkcPid = dcPid;
    myRoom = room;
    myPid = dcPid;

    // Tell both players
    const other = room.players.find(p => p !== socket);
    if (other) other.emit('opponentRejoined', { pid: dcPid });
    socket.emit('rejoinSuccess', { code, pid: dcPid, gameMode: room.gameMode, factions: room.factions });
    console.log(`[+] ${socket.id} rejoined room ${code} as P${dcPid}`);
  });

  // ── OPPONENT DISCONNECTED ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);

    // Remove from public queue if waiting
    const qi = waitingQueue.indexOf(socket);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    const room = rooms.get(socket._bkcRoom);
    if (!room) return;
    const other = room.players.find(p => p !== socket);

    // If game is in progress, start 30s grace period instead of instant cleanup
    if (room.started && other && other.connected) {
      const dcPid = socket._bkcPid;
      room._disconnectedPid = dcPid;
      other.emit('opponentDisconnected', { youWin: false, grace: true, graceSeconds: 30 });
      console.log(`[~] Room ${room.code} P${dcPid} disconnected — 30s grace period`);

      room._graceTimer = setTimeout(() => {
        // Grace period expired — award win
        room._graceTimer = null;
        room._disconnectedPid = null;
        if (other && other.connected) {
          other.emit('opponentDisconnected', { youWin: true, grace: false });
        }
        cleanupRoom(room.code);
        console.log(`[x] Room ${room.code} grace expired — cleaned up`);
      }, 30000);
    } else {
      // Not in game or opponent also gone — clean up immediately
      if (other) other.emit('opponentDisconnected', { youWin: !!room.started, grace: false });
      cleanupRoom(room.code);
    }
  });
});

// ─── EVENT PICKER (mirrors fireRandomEvent logic in client) ───────────────────

function pickEvent({ elapsed, p1hp, p2hp, midOwner }) {
  const hpDiff = Math.abs(p1hp - p2hp);
  const isLopsided = hpDiff > 30;
  const isMidLocked = midOwner !== null;
  const losingPlayerSouls = p1hp < p2hp ? 999 : 0; // simplified — just use lopsided flag

  const pool = [
    ['wanderer', isMidLocked ? 2 : 3],
    ['champion', elapsed > 180 ? 2 : 0],
    ['soul_cache', isLopsided ? 4 : 2],
    ['blood_moon', 2],
    ['ancient_curse', isLopsided ? 3 : 1],
    ['veterans_rally', 2],
    ['supply_drop', isLopsided ? 4 : 1],
    ['dark_eclipse', isMidLocked ? 3 : 1],
    ['meteor', elapsed > 60 ? 2 : 0],
    ['gold_rush', isLopsided ? 1 : 3],
    ['tremor', elapsed > 90 ? 2 : 0],
    ['plague', elapsed > 120 ? 2 : 0],
    ['time_warp', elapsed > 150 ? 2 : 0],
    ['arcane_surge', elapsed > 60 ? 2 : 0],
    ['fog_of_war', elapsed > 90 ? 2 : 0],
  ].filter(([, w]) => w > 0);

  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [id, w] of pool) { r -= w; if (r <= 0) return id; }
  return pool[0][0];
}

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BRC server running on port ${PORT}`));