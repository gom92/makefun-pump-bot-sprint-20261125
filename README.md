# makefun-pump-bot-sprint-20261125

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/gom92/makefun-pump-bot-sprint-20261125/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/gom92/makefun-pump-bot-sprint-20261125/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Steady Breakout Rider — a late-breakout paper-trading bot for pump.fun bonding curves, built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty. One Node program (`main.ts`) that paper-trades a 6-hour pump.fun replay; the house ranks entries by net PnL.

## Strategy

Fresh launches mostly dump, so this bot waits for curves that already proved themselves: at least 11 SOL of real reserves, 20+ trades, price up 50% off launch while sitting within 2% of its own high, with 5+ SOL of genuine buy volume beating sells 1.5x. One 0.28 SOL buy per coin, then a take-profit (+55%), a stop-loss (-18%), a trailing stop (arms at +25%, sells on a 15% pullback), and a stale exit after 300 batches.

On the kit's dev window it scores **+0.31 SOL net PnL over 70 coins (28 wins), max drawdown 7.5%**, and stays positive at 2x fees. The final window is fresh data, so nothing is promised — but the parameters sit in a flat, robust region, not on a knife edge.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. Zero dependencies, erasable TypeScript only — no build, no install. `vendor/makefun-bot.ts` is the kit's protocol shim, copied byte-identical.

## Files

- `main.ts` — entrypoint: wires the strategy to the harness shim.
- `strategy.ts` — the Steady Breakout Rider strategy (tape book, position book, entry bar, exits).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim (vendored, not authored).

---

<sub>Entered on [make.fun](https://make.fun/?ref=radjee14&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
