/**
 * Gestion des connexions Socket.IO et diffusion des mises à jour en temps réel.
 */
export function setupSocket(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket] Client connecté: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`[Socket] Client déconnecté: ${socket.id}`);
    });
  });

  return {
    /**
     * Diffuse une mise à jour des matchs à tous les clients connectés.
     */
    broadcastMatchUpdate(data) {
      io.emit('matches:update', data);
    },

    /**
     * Diffuse un nouvel événement de score.
     */
    broadcastScoreEvent(event) {
      io.emit('match:event', event);
    },
  };
}
