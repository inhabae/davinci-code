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

// Game state
const rooms = new Map();

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.gameStarted = false;
        this.currentPlayer = 0;
        this.flippedCards = [];
        this.maxPlayers = 2;
    }

    addPlayer(playerId, socketId) {
        if (this.players.length < this.maxPlayers) {
            const player = {
                id: playerId,
                socketId: socketId,
                name: `Player ${this.players.length + 1}`
            };
            this.players.push(player);
            return true;
        }
        return false;
    }

    removePlayer(socketId) {
        const index = this.players.findIndex(p => p.socketId === socketId);
        if (index !== -1) {
            this.players.splice(index, 1);
            // Reset game if someone leaves
            this.gameStarted = false;
            this.flippedCards = [];
            this.currentPlayer = 0;
            return true;
        }
        return false;
    }

    canStart() {
        return this.players.length === this.maxPlayers && !this.gameStarted;
    }

    startGame() {
        if (this.canStart()) {
            this.gameStarted = true;
            this.currentPlayer = 0;
            this.flippedCards = [];
            return true;
        }
        return false;
    }

    flipCard(cardNumber, playerId) {
        if (!this.gameStarted || this.flippedCards.includes(cardNumber)) {
            return false;
        }

        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayer) {
            return false; // Not this player's turn
        }

        this.flippedCards.push(cardNumber);
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
        return true;
    }

    isGameComplete() {
        return this.flippedCards.length === 10;
    }

    getGameState() {
        return {
            players: this.players.map((p, index) => ({
                id: p.id,
                name: p.name,
                isCurrentPlayer: index === this.currentPlayer
            })),
            gameStarted: this.gameStarted,
            currentPlayer: this.currentPlayer,
            flippedCards: this.flippedCards,
            isComplete: this.isGameComplete()
        };
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-room', (data) => {
        const { roomId, playerId } = data;
        
        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new GameRoom(roomId));
        }
        
        const room = rooms.get(roomId);
        
        // Check if player is already in room
        const existingPlayer = room.players.find(p => p.id === playerId);
        if (existingPlayer) {
            // Update socket ID for reconnection
            existingPlayer.socketId = socket.id;
        } else {
            // Add new player
            if (!room.addPlayer(playerId, socket.id)) {
                socket.emit('room-full');
                return;
            }
        }
        
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerId = playerId;
        
        // Send updated room state to all players
        io.to(roomId).emit('room-update', room.getGameState());
    });
    
    socket.on('start-game', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        
        // Check if this player is the room leader (first player)
        if (room.players[0] && room.players[0].socketId === socket.id) {
            if (room.startGame()) {
                io.to(roomId).emit('game-started', room.getGameState());
            }
        }
    });
    
    socket.on('flip-card', (cardNumber) => {
        const roomId = socket.roomId;
        const playerId = socket.playerId;
        
        if (!roomId || !playerId || !rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        
        if (room.flipCard(cardNumber, playerId)) {
            io.to(roomId).emit('card-flipped', {
                cardNumber,
                gameState: room.getGameState()
            });
            
            if (room.isGameComplete()) {
                io.to(roomId).emit('game-complete', room.getGameState());
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const roomId = socket.roomId;
        if (roomId && rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.removePlayer(socket.id);
            
            if (room.players.length === 0) {
                // Delete empty room
                rooms.delete(roomId);
            } else {
                // Notify remaining players
                io.to(roomId).emit('room-update', room.getGameState());
            }
        }
    });
});

// API endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', rooms: rooms.size });
});

app.get('/api/rooms/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        res.json(room.getGameState());
    } else {
        res.status(404).json({ error: 'Room not found' });
    }
});

// Serve the client
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Cleanup empty rooms periodically
setInterval(() => {
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.length === 0) {
            rooms.delete(roomId);
        }
    }
}, 300000); // Every 5 minutes
