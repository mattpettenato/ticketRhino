DROP INDEX "events_tm_id_uq";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tm_id_uq" UNIQUE("tm_id");