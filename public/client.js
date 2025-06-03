const socket = io();

// Get DOM elements
const playerCount = document.getElementById('player-count');
const joinButton = document.getElementById('join-button');
const startButton = document.getElementById('start-button');
const gameBoard = document.getElementById('game-board');
const roomIdInput = document.getElementById('room-id');
const playerIdInput = document.getElementById('player-id');

if (!playerCount || !joinButton || !startButton || !gameBoard || !roomIdInput || !playerIdInput) {
    console.error('Missing DOM elements:', { playerCount, joinButton, startButton, gameBoard, roomIdInput, playerIdInput });
}

// Join room
joinButton.addEventListener('click', () => {
    if (!roomIdInput || !playerIdInput) {
        console.error('Input elements not found');
        return;
    }
    const roomId = roomIdInput.value || 'default-room';
    const playerId = playerIdInput.value || `player-${Math.random().toString(36).substr(2, 9)}`;
    console.log('Joining room:', roomId, 'as player:', playerId);
    socket.emit('join-room', { roomId, playerId });
});

// Start game
startButton.addEventListener('click', () => {
    console.log('Starting game');
    socket.emit('start-game');
});

// Handle room updates
socket.on('room-update', (state) => {
    console.log('Room update received:', state);
    playerCount.textContent = `Players: ${state.players.length}/2`;
    startButton.disabled = state.players.length !== 2 || state.gameStarted;
});

// Handle game start
socket.on('game-started', (state) => {
    console.log('Game started:', state);
    gameBoard.style.display = 'block';
    updateGameState(state);
});

// Handle card flip
socket.on('card-flipped', ({ cardNumber, gameState }) => {
    console.log('Card flipped:', cardNumber);
    const card = document.getElementById(`card-${cardNumber}`);
    if (card) {
        card.classList.add('flipped');
    } else {
        console.error('Card not found:', `card-${cardNumber}`);
    }
    updateGameState(gameState);
});

// Handle game completion
socket.on('game-complete', (state) => {
    console.log('Game complete:', state);
    alert('Game Over!');
    updateGameState(state);
});

// Handle room full
socket.on('room-full', () => {
    console.log('Room full');
    alert('Room is full!');
});

// Update game state
function updateGameState(state) {
    state.players.forEach((player, index) => {
        const playerDiv = document.getElementById(`player-${index + 1}`);
        if (playerDiv) {
            playerDiv.textContent = `${player.name} ${player.isCurrentPlayer ? '(Your Turn)' : ''}`;
        } else {
            console.error('Player div not found:', `player-${index + 1}`);
        }
    });
}

// Card click handlers
document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => {
        const cardNumber = parseInt(card.id.split('-')[1]);
        console.log('Flipping card:', cardNumber);
        socket.emit('flip-card', cardNumber);
    });
});