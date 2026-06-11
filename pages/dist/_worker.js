// Pass everything (pages, assets, /ws/* WebSocket upgrades) to the
// tb-racer Worker via the GAME service binding.
export default {
  fetch(request, env) {
    return env.GAME.fetch(request);
  }
};
