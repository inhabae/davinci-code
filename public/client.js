const socket = io();

// Get DOM elements
const playerCount = document.getElementById('player-count');
const joinButton = document.getElementById('join-button');
const startButton = document.getElementById('start-button');
const gameBoard = document.getElementById('game-board');
const roomIdInput = document.getElementById('room-id');
const playerIdInput = document.getElementById('player-id');

// Join room
joinButton.addEventListener('click', () => {
    const roomId = roomIdInput.value || 'default-room';
    const playerId = playerIdInput.value || `player-${Math.random().toString(36).substr(2, 9)}`;
    socket.emit('join-room', { roomId, playerId });
});

// Start game
startButton.addEventListener('click', () => {
    socket.emit('start-game');
});

// Handle room updates
socket.on('room-update', (state) => {
    playerCount.textContent = `Players: ${state.players.length}/2`;
    startButton.disabled = state.players.length !== 2 || state.gameStarted;
});

// Handle game start
socket.on('game-started', (state) => {
    gameBoard.style.display = 'block';
    updateGameState(state);
});

// Handle card flip
socket.on('card-flipped', ({ cardNumber, gameState }) => {
    const card = document.getElementById(`card-${cardNumber}`);
    card.classList.add('flipped');
    updateGameState(gameState);
});

// Handle game completion
socket.on('game-complete', (state) => {
    alert('Game Over!');
    updateGameState(state);
});

// Handle room full
socket.on('room-full', () => {
    alert('Room is full!');
});

// Update game state
function updateGameState(state) {
    state.players.forEach((player, index) => {
        const playerDiv = document.getElementById(`player-${index + 1}`);
        playerDiv.textContent = `${player.name} ${player.isCurrentPlayer ? '(Your Turn)' : ''}`;
    });
}