const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game state - Single room for all players
let gameRoom = null;

class Tile {
    constructor(color, value) {
        this.color = color; // 'white' or 'black'
        this.value = value; // 0-11 or 'joker'
        this.id = `${color}-${value}`;
    }

    // For sorting tiles in hand
    getSortValue() {
        if (this.value === 'joker') {
            return this.color === 'black' ? 12 : 13;
        }
        return this.color === 'black' ? this.value : this.value + 0.5;
    }
}

class GameRoom {
    constructor() {
        this.players = [];
        this.spectators = [];
        this.gameStarted = false;
        this.setupPhase = false;
        this.currentSetupPlayer = 0;
        this.selectedTiles = [[], []]; // Selected tiles for each player
        this.pile = [];
        this.hands = [[], []]; // Two hands for two players
        this.maxPlayers = 2;
        this.createTiles();
    }

    createTiles() {
        this.pile = [];
        
        // Create 13 white tiles (0-11 + joker)
        for (let i = 0; i <= 11; i++) {
            this.pile.push(new Tile('white', i));
        }
        this.pile.push(new Tile('white', 'joker'));
        
        // Create 13 black tiles (0-11 + joker)
        for (let i = 0; i <= 11; i++) {
            this.pile.push(new Tile('black', i));
        }
        this.pile.push(new Tile('black', 'joker'));
        
        // Shuffle the pile
        this.shufflePile();
    }

    shufflePile() {
        for (let i = this.pile.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.pile[i], this.pile[j]] = [this.pile[j], this.pile[i]];
        }
    }

    addPlayer(playerId, socketId, name) {
        if (this.players.length < this.maxPlayers) {
            const player = {
                id: playerId,
                socketId: socketId,
                name: name || `Player ${this.players.length + 1}`,
                seated: false
            };
            this.players.push(player);
            return { success: true, role: 'player' };
        } else {
            // Add as spectator
            const spectator = {
                id: playerId,
                socketId: socketId,
                name: name || `Spectator ${this.spectators.length + 1}`
            };
            this.spectators.push(spectator);
            return { success: true, role: 'spectator' };
        }
    }

    removePlayer(socketId) {
        // Remove from players
        let index = this.players.findIndex(p => p.socketId === socketId);
        if (index !== -1) {
            this.players.splice(index, 1);
            // Reset game if a player leaves
            this.resetGame();
            return true;
        }
        
        // Remove from spectators
        index = this.spectators.findIndex(s => s.socketId === socketId);
        if (index !== -1) {
            this.spectators.splice(index, 1);
            return true;
        }
        
        return false;
    }

    sitDown(socketId) {
        const player = this.players.find(p => p.socketId === socketId);
        if (player && !player.seated && !this.gameStarted) {
            player.seated = true;
            return true;
        }
        return false;
    }

    canStart() {
        return this.players.length === this.maxPlayers && 
               this.players.every(p => p.seated) && 
               !this.gameStarted;
    }

    startGame() {
        if (this.canStart()) {
            this.gameStarted = true;
            this.setupPhase = true;
            this.currentSetupPlayer = 0;
            this.selectedTiles = [[], []];
            return true;
        }
        return false;
    }

    selectTile(playerIndex, tileId) {
        if (!this.setupPhase || this.currentSetupPlayer !== playerIndex) {
            return { success: false, message: "Not your turn to select" };
        }
        
        if (this.selectedTiles[playerIndex].length >= 4) {
            return { success: false, message: "Already selected 4 tiles" };
        }
        
        const tileIndex = this.pile.findIndex(tile => tile.id === tileId);
        if (tileIndex === -1) {
            return { success: false, message: "Tile not found" };
        }
        
        const tile = this.pile[tileIndex];
        if (tile.value === 'joker') {
            return { success: false, message: "Cannot select joker tiles in setup" };
        }
        
        this.selectedTiles[playerIndex].push(tile);
        return { success: true };
    }

    deselectTile(playerIndex, tileId) {
        if (!this.setupPhase || this.currentSetupPlayer !== playerIndex) {
            return { success: false, message: "Not your turn to deselect" };
        }
        
        const tileIndex = this.selectedTiles[playerIndex].findIndex(tile => tile.id === tileId);
        if (tileIndex === -1) {
            return { success: false, message: "Tile not selected" };
        }
        
        this.selectedTiles[playerIndex].splice(tileIndex, 1);
        return { success: true };
    }

    confirmSelection(playerIndex) {
        if (!this.setupPhase || this.currentSetupPlayer !== playerIndex) {
            return { success: false, message: "Not your turn" };
        }
        
        if (this.selectedTiles[playerIndex].length !== 4) {
            return { success: false, message: "Must select exactly 4 tiles" };
        }
        
        // Move selected tiles to hand
        this.selectedTiles[playerIndex].forEach(tile => {
            const pileIndex = this.pile.findIndex(t => t.id === tile.id);
            if (pileIndex !== -1) {
                this.pile.splice(pileIndex, 1);
            }
            this.hands[playerIndex].push(tile);
        });
        
        // Sort hand
        this.sortHand(playerIndex);
        
        // Clear selections
        this.selectedTiles[playerIndex] = [];
        
        // Move to next player or end setup phase
        if (this.currentSetupPlayer === 1) {
            this.setupPhase = false;
            this.currentSetupPlayer = 0;
        } else {
            this.currentSetupPlayer = 1;
        }
        
        return { success: true };
    }

    sortHand(playerIndex) {
        this.hands[playerIndex].sort((a, b) => a.getSortValue() - b.getSortValue());
    }

    resetGame() {
        this.gameStarted = false;
        this.setupPhase = false;
        this.currentSetupPlayer = 0;
        this.selectedTiles = [[], []];
        this.createTiles();
        this.hands = [[], []];
        // Reset seated status
        this.players.forEach(player => player.seated = false);
    }

    getGameState() {
        const seatedPlayers = this.players.filter(p => p.seated);
        
        return {
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                seated: p.seated
            })),
            spectators: this.spectators.map(s => ({
                id: s.id,
                name: s.name
            })),
            gameStarted: this.gameStarted,
            setupPhase: this.setupPhase,
            currentSetupPlayer: this.currentSetupPlayer,
            selectedTiles: this.selectedTiles,
            canStart: this.canStart(),
            seatedCount: seatedPlayers.length,
            pile: this.pile.map(tile => ({ ...tile, faceDown: true })),
            hands: this.hands,
            totalPlayers: this.players.length,
            totalSpectators: this.spectators.length
        };
    }
}

// Initialize single game room
gameRoom = new GameRoom();

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-room', (data) => {
        const { playerId, playerName } = data;
        
        // Check if player is already connected
        const existingPlayer = gameRoom.players.find(p => p.id === playerId);
        const existingSpectator = gameRoom.spectators.find(s => s.id === playerId);
        
        if (existingPlayer) {
            // Update socket ID for reconnection
            existingPlayer.socketId = socket.id;
            socket.playerId = playerId;
            socket.role = 'player';
        } else if (existingSpectator) {
            // Update socket ID for reconnection
            existingSpectator.socketId = socket.id;
            socket.playerId = playerId;
            socket.role = 'spectator';
        } else {
            // Add new player/spectator
            const result = gameRoom.addPlayer(playerId, socket.id, playerName);
            socket.playerId = playerId;
            socket.role = result.role;
        }
        
        // Send updated room state to all clients
        io.emit('room-update', gameRoom.getGameState());
    });
    
    socket.on('sit-down', (data) => {
        if (socket.role === 'player') {
            const { playerName } = data || {};
            const player = gameRoom.players.find(p => p.socketId === socket.id);
            if (player && playerName && playerName.trim()) {
                player.name = playerName.trim();
            }
            if (gameRoom.sitDown(socket.id)) {
                io.emit('room-update', gameRoom.getGameState());
            }
        }
    });
    
    socket.on('start-game', () => {
        // Only seated players can start the game
        const player = gameRoom.players.find(p => p.socketId === socket.id);
        if (player && player.seated) {
            if (gameRoom.startGame()) {
                io.emit('game-started', gameRoom.getGameState());
            }
        }
    });
    
    socket.on('select-tile', (data) => {
        const { tileId } = data;
        const player = gameRoom.players.find(p => p.socketId === socket.id);
        if (player && player.seated) {
            const playerIndex = gameRoom.players.findIndex(p => p.socketId === socket.id);
            const result = gameRoom.selectTile(playerIndex, tileId);
            if (result.success) {
                io.emit('game-update', gameRoom.getGameState());
            } else {
                socket.emit('error', { message: result.message });
            }
        }
    });
    socket.on('deselect-tile', (data) => {
        const { tileId } = data;
        const player = gameRoom.players.find(p => p.socketId === socket.id);
        if (player && player.seated) {
            const playerIndex = gameRoom.players.findIndex(p => p.socketId === socket.id);
            const result = gameRoom.deselectTile(playerIndex, tileId);
            if (result.success) {
                io.emit('game-update', gameRoom.getGameState());
            } else {
                socket.emit('error', { message: result.message });
            }
        }
    });

    socket.on('confirm-selection', () => {
        const player = gameRoom.players.find(p => p.socketId === socket.id);
        if (player && player.seated) {
            const playerIndex = gameRoom.players.findIndex(p => p.socketId === socket.id);
            const result = gameRoom.confirmSelection(playerIndex);
            if (result.success) {
                io.emit('game-update', gameRoom.getGameState());
            } else {
                socket.emit('error', { message: result.message });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        gameRoom.removePlayer(socket.id);
        io.emit('room-update', gameRoom.getGameState());
    });

});

// API endpoints
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        totalPlayers: gameRoom.players.length,
        totalSpectators: gameRoom.spectators.length,
        gameStarted: gameRoom.gameStarted
    });
});

app.get('/api/game-state', (req, res) => {
    res.json(gameRoom.getGameState());
});

// Serve the client
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});