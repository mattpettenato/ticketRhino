CREATE TABLE "event_source_state" (
	"event_id" integer NOT NULL,
	"source" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp with time zone,
	CONSTRAINT "event_source_state_event_id_source_pk" PRIMARY KEY("event_id","source")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tm_id" text,
	"sg_id" text,
	"name" text NOT NULL,
	"artist" text,
	"venue" text,
	"city" text,
	"event_tz" text,
	"starts_at" timestamp with time zone NOT NULL,
	"event_status" text DEFAULT 'upcoming' NOT NULL,
	"artwork_url" text,
	"genre" text,
	"match_confidence" real,
	"match_method" text,
	"matched_at" timestamp with time zone,
	"is_seed" boolean DEFAULT false NOT NULL,
	"polling_enabled" boolean DEFAULT false NOT NULL,
	"tracked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"source" text NOT NULL,
	"price_low" numeric(10, 2),
	"price_high" numeric(10, 2),
	"price_avg" numeric(10, 2),
	"listing_count" integer,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"poll_bucket" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_events" (
	"anon_id" text NOT NULL,
	"event_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_events_anon_id_event_id_pk" PRIMARY KEY("anon_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "event_source_state" ADD CONSTRAINT "event_source_state_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_events" ADD CONSTRAINT "watchlist_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ess_next_poll_idx" ON "event_source_state" USING btree ("next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_tm_id_uq" ON "events" USING btree ("tm_id") WHERE tm_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_sg_id_uq" ON "events" USING btree ("sg_id") WHERE sg_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_poll_idx" ON "events" USING btree ("polling_enabled","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snap_idem_uq" ON "price_snapshots" USING btree ("event_id","source","poll_bucket");--> statement-breakpoint
CREATE INDEX "snap_bucket_idx" ON "price_snapshots" USING btree ("poll_bucket");--> statement-breakpoint
CREATE INDEX "snap_event_bucket_idx" ON "price_snapshots" USING btree ("event_id","poll_bucket" DESC NULLS LAST);