import {
  bigserial, boolean, char, index, integer, numeric, pgTable, primaryKey,
  real, serial, text, timestamp, unique, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  tmId: text("tm_id"),
  sgId: text("sg_id"),
  name: text("name").notNull(),
  artist: text("artist"),
  venue: text("venue"),
  city: text("city"),
  eventTz: text("event_tz"), // IANA tz, DISPLAY ONLY — all signal windows are rolling UTC
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  eventStatus: text("event_status").notNull().default("upcoming"), // upcoming|rescheduled|canceled|past
  artworkUrl: text("artwork_url"),
  genre: text("genre"),
  matchConfidence: real("match_confidence"),
  matchMethod: text("match_method"), // exact_id | fuzzy | manual
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  isSeed: boolean("is_seed").notNull().default(false),
  pollingEnabled: boolean("polling_enabled").notNull().default(false), // invariant: is_seed OR watchers > 0
  trackedAt: timestamp("tracked_at", { withTimezone: true }),
}, (t) => [
  unique("events_tm_id_uq").on(t.tmId),
  uniqueIndex("events_sg_id_uq").on(t.sgId).where(sql`sg_id IS NOT NULL`),
  index("events_poll_idx").on(t.pollingEnabled, t.startsAt),
]);

export const eventSourceState = pgTable("event_source_state", {
  eventId: integer("event_id").notNull().references(() => events.id),
  source: text("source").notNull(), // tm | seatgeek
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
  errorCount: integer("error_count").notNull().default(0),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.eventId, t.source] }),
  index("ess_next_poll_idx").on(t.nextPollAt),
]);

export const watchlistEvents = pgTable("watchlist_events", {
  anonId: text("anon_id").notNull(),
  eventId: integer("event_id").notNull().references(() => events.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.anonId, t.eventId] })]);

export const priceSnapshots = pgTable("price_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventId: integer("event_id").notNull().references(() => events.id),
  source: text("source").notNull(),
  priceLow: numeric("price_low", { precision: 10, scale: 2 }),
  priceHigh: numeric("price_high", { precision: 10, scale: 2 }),
  priceAvg: numeric("price_avg", { precision: 10, scale: 2 }), // resale only; TM rows NULL
  listingCount: integer("listing_count"), // resale only
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  pollBucket: timestamp("poll_bucket", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("snap_idem_uq").on(t.eventId, t.source, t.pollBucket),
  index("snap_bucket_idx").on(t.pollBucket),
  index("snap_event_bucket_idx").on(t.eventId, t.pollBucket.desc()),
]);
