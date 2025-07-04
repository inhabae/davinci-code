// TODO: multiple rooms

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const { group } = require("console");

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
    this.currentPlayerId = null;
    this.whitePile = [];
    this.blackPile = [];
    this.communityPile = [];
    this.playerHands = [[], []];
    this.selectedColors = [[], []];
    this.turnPhase = null; // draw, place, guess
  }

  // Add a player to players
  addPlayer(socket, name) {
    if (this.players.length >= 2) return false;

    this.players.push({
      socket: socket,
      name: name || `Player ${this.players.length + 1}`,
      ready: true,
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

  canStartGame() {
    return this.players.length === 2 && this.players.every((p) => p.ready);
  }

  initializeGame() {
    this.gameState = "setup";
    this.whitePile = [
      "w0ff",
      "w1ff",
      "w2ff",
      "w3ff",
      "w4ff",
      "w5ff",
      "w6ff",
      "w7ff",
      "w8ff",
      "w9ff",
      "wtff",
      "wvff",
    ];
    this.blackPile = [
      "b0ff",
      "b1ff",
      "b2ff",
      "b3ff",
      "b4ff",
      "b5ff",
      "b6ff",
      "b7ff",
      "b8ff",
      "b9ff",
      "btff",
      "bvff",
    ];

    const randomIndex = Math.floor(Math.random() * 2); // 0 or 1
    this.currentPlayerId = this.players[randomIndex].id;
  }

  selectInitialCards(playerId, cardIndices) {
    if (this.gameState !== "setup") return false;
    if (cardIndices.length !== 4) return false;

    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return false;

    // Store selected card colors for this player
    const selectedColors = cardIndices.map((i) => {
      // Determine color based on card position (alternating white/black)
      return i % 2 === 0 ? "white" : "black";
    });

    this.selectedColors[playerIndex] = selectedColors;
    return true;
  }

  // Deal 4 hands to each player and shuffle joker into the pile
  dealInitialHands() {
    this.shuffleArray(this.whitePile);
    this.shuffleArray(this.blackPile);

    console.log("LOGLOG", this.whitePile, this.blackPile);
    const allLetters = "abcdefghijklmnopqrstuvwxyz".split("");

    for (let i = 0; i < 12; i++) {
      this.whitePile[i] = this.whitePile[i] + allLetters[i];
    }
    for (let i = 12; i < 24; i++) {
      this.blackPile[i - 12] = this.blackPile[i - 12] + allLetters[i];
    }

    console.log("LOGLOG", this.whitePile, this.blackPile);
    // Deal cards to each player
    for (let playerIndex = 0; playerIndex < 2; playerIndex++) {
      const selectedColors = this.selectedColors[playerIndex];
      const hand = [];

      for (const color of selectedColors) {
        if (color === "white") {
          hand.push(this.whitePile.pop());
        } else {
          hand.push(this.blackPile.pop());
        }
      }
      this.playerHands[playerIndex] = this.sortInitialHand(hand);
      console.log(
        "[DEBUG] dealInitialHands(): ",
        this.playerHands,
        this.communityPile,
      );
    }

    // Add a joker and shuffle
    this.whitePile.push("wjff" + allLetters[24]);
    this.blackPile.push("bjff" + allLetters[25]);
    this.communityPile = [...this.whitePile, ...this.blackPile];

    for (let i = 0; i < 100; i++) {
      this.shuffleArray(this.communityPile);
    }
  }

  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  // Mark a drawnCard with "d" and return a drawnCard
  drawCard(cardIndex) {
    console.log(
      "BEFORE:",
      this.communityPile,
      cardIndex,
      this.communityPile[cardIndex],
    );
    if (this.communityPile.length === 0) return null;

    const originalCard = this.communityPile[cardIndex];
    const cardCopy = originalCard.slice();

    // Mutate the original (e.g., mark as drawn)
    this.communityPile[cardIndex] =
      originalCard.slice(0, 2) + "d" + originalCard.slice(3);

    console.log("AFTER:", this.communityPile[cardIndex]);
    return cardCopy; // return the unmutated copy
  }

  placeCard(drawnCard, position) {
    const card = drawnCard.slice(0, 3) + "t" + drawnCard.slice(4);
    // 1. Find player index using currentPlayerId
    const playerIndex = this.players.findIndex(
      (p) => p.id === this.currentPlayerId,
    );

    if (playerIndex === -1) {
      console.error("[ERROR] Invalid currentPlayerId; player not found.");
      return;
    }

    // 2. Insert the card into the player's hand at the specified position
    this.playerHands[playerIndex].splice(position, 0, card);
    return true;
  }

  guessCard(opponentCardIndex, value) {
    // joker is already "j" by client's submitGuess()
    let guessedValue = value;
    if (value == 10) {
      guessedValue = "t";
    } else if (value == 11) {
      guessedValue = "v";
    }

    const playerId = this.currentPlayerId;
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (this.turnPhase !== "guess") return null;

    const opponentIndex = 1 - playerIndex;
    const opponentHand = this.playerHands[opponentIndex];

    if (opponentCardIndex >= opponentHand.length) return null;

    const isCorrect = opponentHand[opponentCardIndex][1] == guessedValue;
    console.log(
      "DEBUGGING GUESSING CARD",
      opponentHand[opponentCardIndex][1],
      guessedValue,
      isCorrect,
    );
    if (isCorrect) {
      // Reveal the guessed card
      opponentHand[opponentCardIndex] =
        opponentHand[opponentCardIndex].slice(0, 2) +
        "tf" +
        opponentHand[opponentCardIndex].slice(4);

      // Check if opponent lost (all cards revealed)
      const allRevealed = opponentHand.every((card) => card[2] === "t");

      if (allRevealed) {
        console.log("GAME OVER");
        this.gameState = "finished";
        return {
          correct: true,
          gameOver: true,
          winner: playerIndex,
        };
      }
      // Player can continue guessing or end turn
      return {
        correct: true,
        gameOver: false,
      };
    } else {
      // Reveal player's most recent card
      const playerHand = this.playerHands[playerIndex];

      // Dealing with losing newly drawn card
      for (let i = 0; i < playerHand.length; i++) {
        if (playerHand[i][3] === "t") {
          playerHand[i] =
            playerHand[i].slice(0, 2) +
            "tf" +
            playerHand[playerIndex].slice(0, 2);
          break;
        }
      }

      // Check if current player lost
      const allRevealed = playerHand.every((card) => card[2] === "t");

      if (allRevealed) {
        console.log("GAME OVER");
        this.gameState = "finished";
        return {
          correct: false,
          gameOver: true,
          winner: opponentIndex,
        };
      } else {
        // Ending turn after a wrong guess
        this.currentPlayerId = this.players[1 - playerIndex].id;

        // Check if all community cards are drawn
        const allDrawn = gameRoom.communityPile.every((card) => card[2] == "d");
        console.log("allDRAWN is ", allDrawn);

        if (allDrawn) {
          console.log(
            "[DEBUG] All community cards drawn. Skipping draw phase.",
          );
          gameRoom.turnPhase = "guess";
        } else {
          gameRoom.turnPhase = "draw";
        }
        return {
          correct: false,
          gameOver: false,
        };
      }
    }
  }

  sortInitialHand(hand) {
    return hand.sort((a, b) => {
      const order = "0123456789tv"; // Define the desired character order

      const aValue = order.indexOf(a[1]);
      const bValue = order.indexOf(b[1]);

      if (aValue !== bValue) {
        return aValue - bValue;
      }

      // Same value → black before white
      if (a[0] === "b" && b[0] === "w") return -1;
      if (a[0] === "w" && b[0] === "b") return 1;

      return 0;
    });
  }

  getLobbyState() {
    return {
      gameState: "lobby",
      players: this.players.map((p) => ({
        name: p.name,
        ready: p.ready,
        id: p.id,
      })),
    };
  }

  maskCards(hand) {
    return hand.map((card) => {
      const chars = card.split(""); // Convert string to char array
      const thirdChar = chars[2];

      if (thirdChar === "f" || thirdChar == "d") {
        chars[1] = "n"; // Change first char to 'n'
        return chars.join(""); // Return modified string
      } else if (thirdChar === "t") {
        return card; // Leave it unchanged
      } else {
        console.error("[ERROR] Invalid third character in card: ", card);
        return card; // Or return null/undefined if you want to drop it
      }
    });
  }
  updateGameState(playerId) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    console.log(
      "[DEBUG] updateGameState() with this state: ",
      this.gameState,
      this.currentPlayerId,
      this.turnPhase,
      this.communityPile,
      this.playerHands[playerIndex],
      this.playerHands[1 - playerIndex],
    );
    if (playerIndex === -1) {
      console.log("[ERROR] Player not found");
      return;
    }

    return {
      gameState: this.gameState,
      currentPlayerId: this.currentPlayerId,
      turnPhase: this.turnPhase,
      communityPile: this.maskCards(this.communityPile),
      myHand: this.playerHands[playerIndex],
      oppHand: this.maskCards(this.playerHands[1 - playerIndex]),
    };
  }

  resetGame() {
    this.players = [];
    this.gameState = "lobby";
    this.currentPlayerId = null;
    this.communityPile = [];
    this.playerHands = [[], []];
    this.whitePile = [];
    this.blackPile = [];
    this.selectedColors = [[], []];
    this.turnPhase = null;
  }
}

// BELOW THIS SHOULD BE "gameRoom" instead of using "this"

// Single game room for now
const gameRoom = new GameRoom();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  io.emit("lobbyStateUpdate", gameRoom.getLobbyState());

  // Update player name
  socket.on("updatePlayerName", (data) => {
    console.log("Server received 'updatePlayerName");
    const player = gameRoom.players.find((p) => p.id === socket.id);
    if (player) {
      player.name = data.name;
      io.emit("lobbyStateUpdate", gameRoom.getLobbyState());
    }
  });

  // Join game
  socket.on("joinGame", (data) => {
    console.log("[DEBUG] Server has received 'joinGame'");
    const success = gameRoom.addPlayer(socket, data.name);

    if (success) {
      console.log("[DEBUG] Added a player successfully");
      socket.emit("joinSuccess", { playerId: socket.id });
      io.emit("lobbyStateUpdate", gameRoom.getLobbyState());
    }
  });

  // Start game
  socket.on("startGame", () => {
    if (gameRoom.canStartGame()) {
      gameRoom.initializeGame();
      gameRoom.players.forEach((player) => {
        const playerId = player.id;
        player.socket.emit(
          "gameStateUpdate",
          gameRoom.updateGameState(playerId),
        );
      });


      console.log("[DEBUG] At start of game: ", gameRoom);


      io.emit("gameStarted");
    } else {
      console.log(
        "[ERROR] Start Game button enabled without two ready players",
      );
    }
  });

  // Select initial cards
  socket.on("selectInitialCards", (data) => {
    const success = gameRoom.selectInitialCards(socket.id, data.cardIndices);

    if (success) {
      // Delay update until both players have selected
      console.log("[DEBUG] selectedColors[0] is ", gameRoom.selectedColors[0]);
      console.log("[DEBUG] selectedColors[1] is ", gameRoom.selectedColors[1]);
      if (
        gameRoom.selectedColors[0].length === 4 &&
        gameRoom.selectedColors[1].length === 4
      ) {
        gameRoom.dealInitialHands();

        gameRoom.gameState = "playing";
        gameRoom.turnPhase = "draw";

        gameRoom.players.forEach((player) => {
          const playerId = player.id;
          player.socket.emit(
            "gameStateUpdate",
            gameRoom.updateGameState(playerId),
          );
        });
        io.emit("gamePlaying");
      }
    }
  });

  // Draw card
  socket.on("selectCardFromPile", (data) => {
    const drawnCard = gameRoom.drawCard(data.cardIndex);

    if (drawnCard) {
      console.log("[DEBUG]: cardDrawn has been sent to the client ", drawnCard);
      gameRoom.turnPhase = "place";
      gameRoom.players.forEach((player) => {
        const playerId = player.id;
        player.socket.emit(
          "gameStateUpdate",
          gameRoom.updateGameState(playerId),
        );
      });
      socket.emit("cardDrawn", { card: drawnCard });
    }
  });

  // Place card
  socket.on("placeCard", (data) => {
    console.log("placeCard on server called");

    for (let i = 0; i < gameRoom.playerHands.length; i++) {
      for (let j = 0; j < gameRoom.playerHands[i].length; j++) {
        const card = gameRoom.playerHands[i][j];
        if (card[3] === "t") {
          // Replace third character with "f"
          gameRoom.playerHands[i][j] = card.slice(0, 3) + "f" + card.slice(4);
        }
      }
    }
    const success = gameRoom.placeCard(data.card, data.position);

    if (success) {
      // Mark a newly drawn card, unmark a previous one
      console.log(
        "placecard success, this is current player hand",
        gameRoom.playerHands,
      );
      gameRoom.turnPhase = "guess";
      gameRoom.players.forEach((player) => {
        const playerId = player.id;
        player.socket.emit(
          "gameStateUpdate",
          gameRoom.updateGameState(playerId),
        );
      });
    }
  });
  socket.on("selectOpponentCard", (data) => {
    socket.broadcast.emit("selectOpponentCard", {
      cardIndex: data.cardIndex,
    });
  });

  // Modified “guessCard” handler with the guessIndex emit added:
  socket.on("guessCard", (data) => {
    console.log("[DEBUG] guessCard received");
    // 1) Find the name of the player who made the guess
    const playerIndex = gameRoom.players.findIndex((p) => p.id === socket.id);
    const playerName = gameRoom.players[playerIndex].name;
    // 2) Take the raw guess string from the client
    const guessString = data.guessedValue;
    // 3) Broadcast it to everyone as "lastGuess"
    io.emit("lastGuess", {
      playerName: playerName,
      guessedValue: guessString,
    });

    const cardStr = gameRoom.playerHands[1 - playerIndex];
    const cardId = cardStr[data.cardIndex][4];

    console.log("GEBUD ", cardStr, cardId);
    // 3.1) ALSO emit the unique id of the card that was guessed
    io.emit("guessIndex", {
      playerId: socket.id,
      cardId: cardId,
    });

    // 4) Now process the guess as before
    const result = gameRoom.guessCard(data.cardIndex, data.guessedValue);
    if (result) {
      io.emit("guessResult", {
        correct: result.correct,
        gameOver: result.gameOver,
        winner: result.winner,
      });

      console.log(
        "[DEBUG] YAYAY updateGameState() with this state: ",
        gameRoom.gameState,
        gameRoom.currentPlayerId,
        gameRoom.turnPhase,
        gameRoom.communityPile,
        gameRoom.playerHands[0],
        gameRoom.playerHands[1 - 0],
      );

      gameRoom.players.forEach((player) => {
        const playerId = player.id;
        player.socket.emit(
          "gameStateUpdate",
          gameRoom.updateGameState(playerId),
        );
      });
      if (result.gameOver) {
        const winnerName = gameRoom.players[result.winner].name;
        io.emit("gameFinished", { winner: winnerName });
      }
    }
  });

  // End turn (when player chooses not to continue guessing)
  socket.on("endTurn", () => {
    if (gameRoom.turnPhase === "guess") {
      const playerIndex = gameRoom.players.findIndex(
        (p) => p.id === gameRoom.currentPlayerId,
      );
      gameRoom.currentPlayerId = gameRoom.players[1 - playerIndex].id;

      // Check if all community cards are drawn
      const allDrawn = gameRoom.communityPile.every((card) => card[2] == "d");
      console.log("allDRAWN is ", allDrawn);

      if (allDrawn) {
        console.log("[DEBUG] All community cards drawn. Skipping draw phase.");
        gameRoom.turnPhase = "guess";
      } else {
        gameRoom.turnPhase = "draw";
      }

      gameRoom.players.forEach((player) => {
        const playerId = player.id;
        player.socket.emit(
          "gameStateUpdate",
          gameRoom.updateGameState(playerId),
        );
      });
    }
  });

  // New game
  socket.on("newGame", () => {
    gameRoom.resetGame();
    io.emit("lobbyStateUpdate", gameRoom.getLobbyState());
    io.emit("gameReset");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // 1) Remove the socket from the player list immediately
    const wasInGame = gameRoom.players.some((p) => p.id === socket.id);
    gameRoom.removePlayer(socket.id);

    if (wasInGame) {
      // 2) Now reset the game state (hands, piles, turnPhase, etc.)
      gameRoom.resetGame();

      // 3) Broadcast new lobby state to the remaining client(s)
      io.emit("lobbyStateUpdate", gameRoom.getLobbyState());

      // 4) Then tell everyone “gameReset” so that client.resetGame() runs
      io.emit("gameReset");
    }
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
