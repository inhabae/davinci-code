const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Game state management
class GameRoom {
  constructor() {
    this.players = [];
    this.gameState = "lobby"; // lobby, setup, playing, finished
    this.currentPlayer = 0;
    this.communityPile = [];
    this.playerHands = [[], []];
    this.revealedCards = [new Set(), new Set()];
    this.selectedCards = [[], []];
    this.turnPhase = "draw"; // draw, place, guess
  }

  addPlayer(socket, name) {
    if (this.players.length >= 2) return false;

    this.players.push({
      socket: socket,
      name: name || `Player ${this.players.length + 1}`,
      ready: false,
      id: socket.id,
    });

    return true;
  }

  removePlayer(socketId) {
    this.players = this.players.filter((p) => p.id !== socketId);
    if (this.players.length === 0) {
      this.resetGame();
    }
  }

  setPlayerReady(socketId, ready) {
    const player = this.players.find((p) => p.id === socketId);
    if (player) {
      player.ready = ready;
      return true;
    }
    return false;
  }

  canStartGame() {
    return this.players.length === 2 && this.players.every((p) => p.ready);
  }

  createSetupPlaceholders() {
    const placeholders = [];
    for (let i = 0; i < 26; i++) {
      placeholders.push({
        color: i % 2 === 0 ? "white" : "black",
        value: null,
        hidden: true,
        drawn: false,
        communityIndex: i,
      });
    }
    return placeholders;
  }

  initializeGame() {
    this.gameState = "setup";
    this.communityPile = this.createSetupPlaceholders();
    this.playerHands = [[], []];
    this.revealedCards = [new Set(), new Set()];
    this.selectedCards = [[], []];
    this.currentPlayer = Math.floor(Math.random() * 2);
    this.turnPhase = "draw";
  }

  createShuffledDeck() {
    const deck = [];
    const whiteValues = Array.from({ length: 12 }, (_, i) => i);
    const blackValues = Array.from({ length: 12 }, (_, i) => i);

    this.shuffleArray(whiteValues);
    this.shuffleArray(blackValues);

    let whiteIndex = 0;
    let blackIndex = 0;
    let communityIndex = 0;

    // First, account for selectedCards from both players
    const usedColors = [
      ...(this.selectedCards[0] || []),
      ...(this.selectedCards[1] || []),
    ];

    for (const color of usedColors) {
      if (color === "white") whiteIndex++;
      else if (color === "black") blackIndex++;
    }

    console.log("[DEBUG]: whiteIndex: ", whiteIndex);
    console.log("[DEBUG]: blackIndex: ", blackIndex);

    // Build the community pile from the remaining values
    while (whiteIndex < 12 || blackIndex < 12) {
      let color;
      if (whiteIndex < 12 && blackIndex < 12) {
        // Alternate for visual variety
        color = communityIndex % 2 === 0 ? "white" : "black";
      } else if (whiteIndex < 12) {
        color = "white";
      } else {
        color = "black";
      }

      deck.push({
        color,
        value: null,
        hidden: true,
        drawn: false,
        communityIndex: communityIndex++,
      });

      if (color === "white") whiteIndex++;
      else blackIndex++;
    }

    deck.push({
      color: "white",
      value: "joker",
      hidden: true,
      drawn: false,
      communityIndex: communityIndex++,
    });
    deck.push({
      color: "black",
      value: "joker",
      hidden: true,
      drawn: false,
      communityIndex: communityIndex++,
    });

    return deck;
  }

  selectInitialCards(playerId, cardIndices) {
    this.communityPile = this.createShuffledDeck();
    if (this.gameState !== "setup") return false;
    if (cardIndices.length !== 4) return false;

    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return false;

    // Store selected card colors for this player
    const selectedColors = cardIndices.map((i) => {
      // Determine color based on card position (alternating white/black)
      return i % 2 === 0 ? "white" : "black";
    });

    this.selectedCards[playerIndex] = selectedColors;
    return true;
  }

  dealInitialHands() {
    const whiteValues = Array.from({ length: 12 }, (_, i) => i); // 0-11
    const blackValues = Array.from({ length: 12 }, (_, i) => i); // 0-11

    // Shuffle available values
    this.shuffleArray(whiteValues);
    this.shuffleArray(blackValues);

    let whiteIndex = 0;
    let blackIndex = 0;

    // Deal cards to each player
    for (let playerIndex = 0; playerIndex < 2; playerIndex++) {
      const selectedColors = this.selectedCards[playerIndex];
      const hand = [];

      for (const color of selectedColors) {
        let value;
        if (color === "white") {
          value = whiteValues[whiteIndex++];
        } else {
          value = blackValues[blackIndex++];
        }

        hand.push({
          color: color,
          value: value,
          hidden: false,
          revealed: false,
        });
      }

      this.playerHands[playerIndex] = this.sortHand(hand);
    }

    // Remove dealt cards from community pile
    const totalDealtCards = 8; // 4 cards per player
    this.communityPile = this.communityPile.slice(totalDealtCards);
  }

  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  getAvailableValues(color) {
    const allValues = Array.from({ length: 12 }, (_, i) => i); // 0-11
    const usedValues = [];

    // Check what values are already used
    this.playerHands.forEach((hand) => {
      hand.forEach((card) => {
        if (card.color === color && card.value !== "joker") {
          usedValues.push(card.value);
        }
      });
    });

    return allValues.filter((val) => !usedValues.includes(val));
  }

  drawCard(playerId, cardIndex = null) {
    console.log("[DEBUG] drawCard() on server.js: cardIndex is ", cardIndex);
    if (this.gameState !== "playing") return null;

    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayer) return null;
    if (this.turnPhase !== "draw") return null;
    if (this.communityPile.length === 0) return null;

    // If specific card index provided, use it (bounded by available cards)
    const actualIndex = cardIndex;

    if (actualIndex < 0 || actualIndex >= this.communityPile.length) {
      return null; // invalid index
    }

    const drawnCardMeta = this.communityPile[actualIndex];
    if (!drawnCardMeta || drawnCardMeta.drawn) return null;

    drawnCardMeta.drawn = true;

    const drawnCard = {
      color: drawnCardMeta.color,
      hidden: false,
      revealed: false,
    };

    if (drawnCardMeta.value === "joker") {
      drawnCard.value = "joker";
    } else {
      const availableValues = this.getAvailableValues(drawnCard.color);
      if (availableValues.length > 0) {
        drawnCard.value =
          availableValues[Math.floor(Math.random() * availableValues.length)];
      } else {
        // fallback: return null or handle "out of values" gracefully
        return null;
      }
    }

    this.turnPhase = "place";
    return drawnCard;
  }

  placeCard(playerId, card, position = null) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayer) return false;
    if (this.turnPhase !== "place") return false;

    if (card.value === "joker") {
      // Joker can be placed anywhere
      if (position !== null) {
        this.playerHands[playerIndex].splice(position, 0, card);
      } else {
        this.playerHands[playerIndex].push(card);
      }
    } else {
      // Non-joker: insert at the provided position (client already computed correct index)
      if (position !== null) {
        this.playerHands[playerIndex].splice(position, 0, card);
      } else {
        // fallback: if no position provided, just append
        this.playerHands[playerIndex].push(card);
      }
    }

    this.turnPhase = "guess";
    return true;
  }

  guessCard(playerId, opponentCardIndex, guessedValue) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayer) return null;
    if (this.turnPhase !== "guess") return null;

    const opponentIndex = 1 - playerIndex;
    const opponentHand = this.playerHands[opponentIndex];

    if (opponentCardIndex >= opponentHand.length) return null;

    const targetCard = opponentHand[opponentCardIndex];
    const isCorrect = targetCard.value === guessedValue;

    if (isCorrect) {
      // Reveal the guessed card
      this.revealedCards[opponentIndex].add(opponentCardIndex);

      // Check if opponent lost (all cards revealed)
      if (this.revealedCards[opponentIndex].size === opponentHand.length) {
        this.gameState = "finished";
        return { correct: true, gameOver: true, winner: playerIndex };
      }

      // Player can continue guessing or end turn
      return { correct: true, gameOver: false };
    } else {
      // Reveal player's most recent card
      const playerHand = this.playerHands[playerIndex];
      if (playerHand.length > 0) {
        const mostRecentIndex = playerHand.length - 1;
        this.revealedCards[playerIndex].add(mostRecentIndex);

        // Check if current player lost
        if (this.revealedCards[playerIndex].size === playerHand.length) {
          this.gameState = "finished";
          return { correct: false, gameOver: true, winner: opponentIndex };
        }
      }

      // End turn
      this.currentPlayer = 1 - this.currentPlayer;
      this.turnPhase = "draw";
      return { correct: false, gameOver: false };
    }
  }

  sortHand(hand) {
    return hand.sort((a, b) => {
      // Jokers can be anywhere, don't sort them
      if (a.value === "joker" || b.value === "joker") return 0;

      // Sort by value first
      if (a.value !== b.value) {
        return a.value - b.value;
      }

      // If same value, black comes before white
      if (a.color === "black" && b.color === "white") return -1;
      if (a.color === "white" && b.color === "black") return 1;

      return 0;
    });
  }

  getGameState() {
    return {
      gameState: this.gameState,
      players: this.players.map((p) => ({
        name: p.name,
        ready: p.ready,
        id: p.id,
      })),
      currentPlayer: this.currentPlayer,
      turnPhase: this.turnPhase,
      communityPile: this.communityPile,
      communityPileSize: this.communityPile.filter((c) => !c.drawn).length,

      playerHands: this.playerHands.map((hand, index) =>
        hand.map((card, cardIndex) => ({
          ...card,
          revealed: this.revealedCards[index].has(cardIndex),
        })),
      ),
    };
  }

  resetGame() {
    this.gameState = "lobby";
    this.currentPlayer = 0;
    this.communityPile = [];
    this.playerHands = [[], []];
    this.revealedCards = [new Set(), new Set()];
    this.selectedCards = [[], []];
    this.turnPhase = "draw";
    this.players.forEach((p) => (p.ready = false));
  }
}

// Single game room for now
const gameRoom = new GameRoom();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join game
  socket.on("joinGame", (data) => {
    const success = gameRoom.addPlayer(socket, data.name);

    if (success) {
      socket.emit("joinSuccess", { playerId: socket.id });
      io.emit("gameStateUpdate", gameRoom.getGameState());
    } else {
      socket.emit("joinFailed", { message: "Game is full" });
    }
  });

  // Player ready
  socket.on("playerReady", () => {
    gameRoom.setPlayerReady(socket.id, true);
    io.emit("gameStateUpdate", gameRoom.getGameState());
  });

  // Start game
  socket.on("startGame", () => {
    if (gameRoom.canStartGame()) {
      gameRoom.initializeGame();
      io.emit("gameStateUpdate", gameRoom.getGameState());
      io.emit("gameStarted");
    }
  });

  // Select initial cards
  socket.on("selectInitialCards", (data) => {
    const success = gameRoom.selectInitialCards(socket.id, data.cardIndices);

    if (success) {
      // Delay update until both players have selected
      if (
        gameRoom.selectedCards[0].length === 4 &&
        gameRoom.selectedCards[1].length === 4
      ) {
        gameRoom.dealInitialHands();
        gameRoom.communityPile = gameRoom.createShuffledDeck();
        gameRoom.gameState = "playing";
        io.emit("gameStateUpdate", gameRoom.getGameState());
        io.emit("gamePlaying");
      } else {
        socket.emit("partialSelectionAcknowledged", {
          message: "Waiting for other player to finish selection.",
        });
      }

      // Check if both players have selected
      if (
        gameRoom.selectedCards[0].length === 4 &&
        gameRoom.selectedCards[1].length === 4
      ) {
        gameRoom.dealInitialHands();
        gameRoom.communityPile = gameRoom.createShuffledDeck(); // NOW build the deck
        gameRoom.gameState = "playing";
        io.emit("gameStateUpdate", gameRoom.getGameState());
        io.emit("gamePlaying");
      }
    }
  });

  // Draw card
  socket.on("selectCardFromPile", (data) => {
    console.log(
      '[DEBUG] detecting "selectCardFromPile" on server.js: cardIndex is ',
      data.cardIndex,
    );
    const drawnCard = gameRoom.drawCard(socket.id, data.cardIndex);

    if (drawnCard) {
      socket.emit("cardDrawn", { card: drawnCard });
      io.emit("gameStateUpdate", gameRoom.getGameState());
    }
  });

  // Place card
  socket.on("placeCard", (data) => {
    const success = gameRoom.placeCard(socket.id, data.card, data.position);

    if (success) {
      io.emit("gameStateUpdate", gameRoom.getGameState());
    }
  });

  // Guess card
  socket.on("guessCard", (data) => {
    const result = gameRoom.guessCard(
      socket.id,
      data.cardIndex,
      data.guessedValue,
    );

    if (result) {
      io.emit("guessResult", {
        playerId: socket.id,
        correct: result.correct,
        gameOver: result.gameOver,
        winner: result.winner,
      });

      io.emit("gameStateUpdate", gameRoom.getGameState());

      if (result.gameOver) {
        const winnerName = gameRoom.players[result.winner].name;
        io.emit("gameFinished", { winner: winnerName });
      }
    }
  });

  // End turn (when player chooses not to continue guessing)
  socket.on("endTurn", () => {
    if (gameRoom.turnPhase === "guess") {
      gameRoom.currentPlayer = 1 - gameRoom.currentPlayer;
      gameRoom.turnPhase = "draw";
      io.emit("gameStateUpdate", gameRoom.getGameState());
    }
  });

  // New game
  socket.on("newGame", () => {
    gameRoom.resetGame();
    io.emit("gameStateUpdate", gameRoom.getGameState());
    io.emit("gameReset");
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    gameRoom.removePlayer(socket.id);
    io.emit("gameStateUpdate", gameRoom.getGameState());
  });
});

// Health check endpoint for Render
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`Da Vinci Code server running on port ${PORT}`);
});
