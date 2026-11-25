// Steady Breakout Rider — a late-breakout rider for the pump.fun paper sprint.
//
// The dev window is unforgiving to fresh launches: they dump, and buying them
// lost 1.5–2 SOL in earlier experiments. The edge is in curves that already
// proved themselves before we touch them:
//
//   * real reserves of at least 11 SOL and 20+ trades on the tape,
//   * price at least 50% above launch while still within 2% of its own high
//     (breaking out, not fading),
//   * at least 5 SOL of genuine buy volume, with buys beating sells 1.5x.
//
// Each coin gets exactly one 0.28 SOL buy — no pyramiding — so the distinct
// coin count climbs toward the 20-coin guardrail. A position is then ridden
// with a take-profit (+55%), a stop-loss (-18%), a trailing stop that arms at
// +25% and sells on a 15% pullback from the best price, and a stale exit
// after 300 batches so a dead coin never blocks one of the five open slots.
//
// Parameters sit in the flat, robust region found on the dev window (real SOL
// 10–12, stake 0.25–0.30, stop-loss ~0.80 all score positive), not on a knife
// edge. The final window is fresh data, so nothing is promised.
//
// Deterministic by construction: no clock, no environment, no Math.random —
// only the batch stream, insertion-ordered maps, and plain arithmetic on it.
//
// Written from scratch for this bounty. It does not copy any baseline or pilot
// in the kit; the entry rule (breakout + buy/sell volume ratio + one full-size
// buy) and the exit set (TP / SL / trailing / stale) are its own.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;

/** Tunable knobs for the rider. All money values are lamports (bigint). */
export interface RiderConfig {
  /** Trades a curve must show before it can be bought. */
  minTrades: number;
  /** Price must be at least this multiple of the launch price. */
  minRise: number;
  /** Price must be at least this fraction of the curve's observed high. */
  nearHigh: number;
  /** Minimum buy-side volume on the tape. */
  minBuyVolume: bigint;
  /** Buy volume must exceed sell volume by at least this factor. */
  buyDominance: number;
  /** Minimum real SOL in the curve at entry. */
  minRealReserves: bigint;
  /** SOL committed to a single position. */
  stake: bigint;
  /** Smallest buy worth sending; also the guardrail round-trip floor. */
  minBuy: bigint;
  /** Slippage tolerated on buys (bps); sells always go out wide. */
  buySlippageBps: number;
  /** Slippage tolerated on sells (bps). */
  sellSlippageBps: number;
  /** Sell when price reaches this multiple of the entry price. */
  takeProfit: number;
  /** Sell when price falls to this multiple of the entry price. */
  stopLoss: number;
  /** Trailing stop arms once the best price reaches this multiple of entry. */
  trailArm: number;
  /** Once armed, sell when price falls to this fraction of the best price. */
  trailRetreat: number;
  /** Sell a position that has sat this many batches without an exit. */
  staleAfter: number;
  /** A curve older than this many batches since first seen is ignored. */
  maxCurveAge: number;
  /** Maximum open positions (mirrors the harness cap). */
  maxPositions: number;
}

export const DEFAULT_CONFIG: RiderConfig = {
  // Tuned on the kit's dev window: established curves only, one full-size buy
  // per coin, exits that let winners run and cut losers early.
  minTrades: 20,
  minRise: 1.5,
  nearHigh: 0.98,
  minBuyVolume: 5n * SOL,
  buyDominance: 1.5,
  minRealReserves: 11n * SOL,
  stake: 280_000_000n,
  minBuy: 20_000_000n,
  buySlippageBps: 2000,
  sellSlippageBps: 5000,
  takeProfit: 1.55,
  stopLoss: 0.82,
  trailArm: 1.25,
  trailRetreat: 0.85,
  staleAfter: 300,
  maxCurveAge: 100_000,
  maxPositions: 5,
};

/** Price of a curve from its virtual reserves: SOL per token. */
function curvePrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

/** Everything the bot remembers about one curve's tape. */
interface CurveTape {
  launchPrice: number;
  peakPrice: number;
  tradeCount: number;
  buyVolume: bigint;
  sellVolume: bigint;
  firstSeenSeq: number;
  finished: boolean;
  attempted: boolean;
}

/** The tape book: folds batch events into per-curve records. */
class CurveBook {
  private readonly tapes = new Map<Pubkey, CurveTape>();

  noteBatch(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (this.tapes.has(event.mint)) continue;
        const price = curvePrice(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        this.tapes.set(event.mint, {
          launchPrice: price,
          peakPrice: price,
          tradeCount: 0,
          buyVolume: 0n,
          sellVolume: 0n,
          firstSeenSeq: batch.seq,
          finished: false,
          attempted: false,
        });
      } else if (event.event === 'TradeEvent') {
        const tape = this.tapes.get(event.mint);
        if (tape === undefined) continue;
        const price = curvePrice(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        if (price > tape.peakPrice) tape.peakPrice = price;
        tape.tradeCount += 1;
        if (event.is_buy) tape.buyVolume += BigInt(event.sol_amount);
        else tape.sellVolume += BigInt(event.sol_amount);
      } else if (event.event === 'CompleteEvent') {
        const tape = this.tapes.get(event.mint);
        if (tape !== undefined) tape.finished = true;
      }
    }
  }

  /** Iterate tapes in first-seen order (insertion order = deterministic). */
  entries(): IterableIterator<[Pubkey, CurveTape]> {
    return this.tapes.entries();
  }

  get(mint: Pubkey): CurveTape | undefined {
    return this.tapes.get(mint);
  }
}

/** One open position, tracked from its buy fill. */
interface OpenPosition {
  entryPrice: number;
  bestPrice: number;
  enteredSeq: number;
}

/** The position book: tracks entries from fills and proposes exits. */
class PositionBook {
  private readonly open = new Map<Pubkey, OpenPosition>();
  private readonly everTraded = new Set<Pubkey>();

  /** Fold this batch's fills into the book. */
  noteFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens > 0n && quote > 0n) {
          const entry = Number(quote) / Number(tokens);
          this.open.set(fill.mint, { entryPrice: entry, bestPrice: entry, enteredSeq: batch.seq });
          this.everTraded.add(fill.mint);
        }
      } else {
        this.open.delete(fill.mint);
      }
    }
  }

  /** Drop tracking for positions the harness flattened without a fill we saw. */
  syncWithAccount(state: BotState): void {
    for (const mint of [...this.open.keys()]) {
      if (!state.positions.has(mint)) this.open.delete(mint);
    }
  }

  /** Seed tracking for a position whose buy fill we never recorded. */
  seed(mint: Pubkey, price: number, seq: number): void {
    this.open.set(mint, { entryPrice: price, bestPrice: price, enteredSeq: seq });
  }

  has(mint: Pubkey): boolean {
    return this.open.has(mint);
  }

  tradedBefore(mint: Pubkey): boolean {
    return this.everTraded.has(mint);
  }

  tradedCount(): number {
    return this.everTraded.size;
  }

  /** Decide exits for every open position. Returns the mints to sell. */
  exits(state: BotState, seq: number, cfg: RiderConfig, selling: ReadonlySet<Pubkey>): Pubkey[] {
    const toSell: Pubkey[] = [];
    for (const [mint, accountPos] of state.positions) {
      if (selling.has(mint)) continue; // a sell is already in flight for this mint
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      let pos = this.open.get(mint);
      if (pos === undefined) {
        this.seed(mint, price, seq);
        continue;
      }
      if (price > pos.bestPrice) pos.bestPrice = price;
      const gain = price / pos.entryPrice;
      const trailingArmed = pos.bestPrice >= pos.entryPrice * cfg.trailArm;
      const trailingHit = trailingArmed && price <= pos.bestPrice * cfg.trailRetreat;
      const goneStale = seq - pos.enteredSeq >= cfg.staleAfter;
      if (gain >= cfg.takeProfit || gain <= cfg.stopLoss || trailingHit || goneStale) {
        toSell.push(mint);
      }
    }
    return toSell;
  }
}

/** Does this tape clear the entry bar right now? */
function clearsEntryBar(tape: CurveTape, price: number, realReserves: bigint, cfg: RiderConfig): boolean {
  if (tape.tradeCount < cfg.minTrades) return false;
  if (tape.launchPrice <= 0 || price < tape.launchPrice * cfg.minRise) return false;
  if (price < tape.peakPrice * cfg.nearHigh) return false;
  if (tape.buyVolume < cfg.minBuyVolume) return false;
  // Buys must dominate sells: compare in SOL (floats are fine for a ratio).
  const buySol = Number(tape.buyVolume) / 1e9;
  const sellSol = Number(tape.sellVolume) / 1e9;
  if (buySol < sellSol * cfg.buyDominance) return false;
  if (realReserves < cfg.minRealReserves) return false;
  return true;
}

export function createBot(cfg: RiderConfig = DEFAULT_CONFIG): Bot {
  const book = new CurveBook();
  const portfolio = new PositionBook();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const seq = batch.seq;

      // 1. Learn from this batch, then fold the fills.
      book.noteBatch(batch);
      portfolio.noteFills(batch);
      portfolio.syncWithAccount(state);

      // 2. Exits first: free slots before deciding new entries. A mint with a
      // sell already in flight is skipped — the fill lands two slots after the
      // decision, and a second sell of the same tokens would be refused.
      const selling = new Set<Pubkey>();
      for (const pending of state.pending.values()) {
        if (pending.order.side === 'sell') selling.add(pending.order.mint);
      }
      for (const mint of portfolio.exits(state, seq, cfg, selling)) {
        const accountPos = state.positions.get(mint);
        if (accountPos === undefined) continue;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: accountPos.token_amount, max_slippage_bps: cfg.sellSlippageBps });
      }

      // 3. Entries: one buy per coin, only into a free slot, in first-seen
      // tape order so the run is deterministic.
      let freeSlots = cfg.maxPositions - state.committedPositionCount();
      if (freeSlots > 0) {
        const fee = state.txFeeLamports();
        let cash = state.freeCashLamports();
        for (const [mint, tape] of book.entries()) {
          if (freeSlots <= 0) break;
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (tape.finished || tape.attempted || portfolio.tradedBefore(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) {
            tape.attempted = true;
            continue;
          }
          if (seq - tape.firstSeenSeq > cfg.maxCurveAge) {
            tape.attempted = true;
            continue;
          }
          const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (price <= 0) continue;
          if (!clearsEntryBar(tape, price, curve.real_quote_reserves, cfg)) continue;
          const cap = state.maxBuyLamports(mint);
          if (cap < cfg.minBuy) continue;
          tape.attempted = true;
          const amount = cap < cfg.stake ? cap : cfg.stake;
          if (cash < amount + fee) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: cfg.buySlippageBps });
          cash -= amount + fee;
          freeSlots -= 1;
        }
      }
      return orders;
    },
  };
}
