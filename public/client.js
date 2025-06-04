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
        this.pile = [];
        this.hands = [[], []]; // Two hands for two players
        this.maxPlayers = 2;
        this.currentTurn = 0; // 0 or 1, indicates whose turn it is
        this.setupPhase = false; // true during initial tile selection
        this.tilesSelectedCount = 0; // Track how many tiles have been selected
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
            this.currentTurn = 0;
            this.tilesSelectedCount = 0;
            this.setupGame();
            return true;
        }
        return false;
    }

    setupGame() {
        // Reset hands
        this.hands = [[], []];
        // Game is now in setup phase where players take turns selecting tiles
    }

    selectTile(socketId, tileIndex) {
        if (!this.setupPhase || !this.gameStarted) {
            return { success: false, message: 'Not in setup phase' };
        }

        // Find which player is making the selection
        const playerIndex = this.players.findIndex(p => p.socketId === socketId);
        if (playerIndex === -1) {
            return { success: false, message: 'Player not found' };
        }

        // Check if it's the player's turn
        if (playerIndex !== this.currentTurn) {
            return { success: false, message: 'Not your turn' };
        }

        // Check if each player already has 4 tiles
        if (this.hands[playerIndex].length >= 4) {
            return { success: false, message: 'You already have 4 tiles' };
        }

        // Check if tile index is valid
        if (tileIndex < 0 || tileIndex >= this.pile.length) {
            return { success: false, message: 'Invalid tile index' };
        }

        const selectedTile = this.pile[tileIndex];
        
        // If selected tile is a joker, replace with random non-joker of same color
        let finalTile = selectedTile;
        if (selectedTile.value === 'joker') {
            const availableNonJokers = this.pile.filter(tile => 
                tile.color === selectedTile.color && 
                tile.value !== 'joker'
            );
            
            if (availableNonJokers.length > 0) {
                const randomIndex = Math.floor(Math.random() * availableNonJokers.length);
                finalTile = availableNonJokers[randomIndex];
                
                // Remove the selected non-joker from pile
                const finalTileIndex = this.pile.findIndex(tile => tile.id === finalTile.id);
                this.pile.splice(finalTileIndex, 1);
            } else {
                return { success: false, message: 'No non-joker tiles available in that color' };
            }
        } else {
            // Remove the selected tile from pile
            this.pile.splice(tileIndex, 1);
        }

        // Add tile to player's hand
        this.hands[playerIndex].push(finalTile);
        
        // Sort the hand
        this.sortHand(playerIndex);
        
        // Increment tiles selected count
        this.tilesSelectedCount++;
        
        // Switch turns
        this.currentTurn = (this.currentTurn + 1) % 2;
        
        // Check if setup phase is complete (8 tiles total selected)
        if (this.tilesSelectedCount >= 8) {
            this.setupPhase = false;
            this.currentTurn = 0; // Reset for main game
        }

        return { 
            success: true, 
            selectedTile: finalTile,
            setupComplete: !this.setupPhase
        };
    }

    sortHand(playerIndex) {
        this.hands[playerIndex].sort((a, b) => a.getSortValue() - b.getSortValue());
    }

    resetGame() {
        this.gameStarted = false;
        this.setupPhase = false;
        this.currentTurn = 0;
        this.tilesSelectedCount = 0;
        this.createTiles();
        this.hands = [[], []];
        // Reset seated status
        this.players.forEach(player => player.seated = false);
    }

    getGameState(requestingSocketId = null) {
        const seatedPlayers = this.players.filter(p => p.seated);
        
        // Determine if the requesting player is a seated player and their index
        let playerIndex = -1;
        if (requestingSocketId) {
            playerIndex = this.players.findIndex(p => p.socketId === requestingSocketId && p.seated);
        }
        
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
            currentTurn: this.currentTurn,
            canStart: this.canStart(),
            seatedCount: seatedPlayers.length,
            pile: this.pile.map(tile => ({ ...tile, faceDown: true })),
            // Only send the requesting player's hand, hide opponent's tiles
            hands: this.gameStarted ? [
                playerIndex === 0 ? this.hands[0] : this.hands[0].map(() => ({ hidden: true })),
                playerIndex === 1 ? this.hands[1] : this.hands[1].map(() => ({ hidden: true }))
            ] : [[], []],
            myPlayerIndex: playerIndex,
            totalPlayers: this.players.length,
            totalSpectators: this.spectators.length,
            tilesSelectedCount: this.tilesSelectedCount
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
        
        // Send personalized game state to the connecting client
        socket.emit('room-update', gameRoom.getGameState(socket.id));
        
        // Send updated room state to all other clients
        socket.broadcast.emit('room-update', gameRoom.getGameState());
    });
    
    socket.on('sit-down', () => {
        if (socket.role === 'player') {
            if (gameRoom.sitDown(socket.id)) {
                // Send updated state to all clients
                io.sockets.sockets.forEach((clientSocket) => {
                    clientSocket.emit('room-update', gameRoom.getGameState(clientSocket.id));
                });
            }
        }
    });
    
    socket.on('start-game', () => {
        // Only seated players can start the game
        const player = gameRoom.players.find(p => p.socketId === socket.id);
        if (player && player.seated) {
            if (gameRoom.startGame()) {
                // Send personalized game state to all clients
                io.sockets.sockets.forEach((clientSocket) => {
                    clientSocket.emit('game-started', gameRoom.getGameState(clientSocket.id));
                });
            }
        }
    });

    socket.on('select-tile', (data) => {
        const { tileIndex } = data;
        const result = gameRoom.selectTile(socket.id, tileIndex);
        
        if (result.success) {
            // Send updated game state to all clients
            io.sockets.sockets.forEach((clientSocket) => {
                clientSocket.emit('tile-selected', {
                    ...gameRoom.getGameState(clientSocket.id),
                    selectedTile: result.selectedTile,
                    setupComplete: result.setupComplete
                });
            });
        } else {
            // Send error only to the requesting client
            socket.emit('selection-error', { message: result.message });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        gameRoom.removePlayer(socket.id);
        
        // Send updated state to remaining clients
        io.sockets.sockets.forEach((clientSocket) => {
            clientSocket.emit('room-update', gameRoom.getGameState(clientSocket.id));
        });
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