-- Streaming passthrough is opt-in per upstream; existing upstreams stay buffered.
ALTER TABLE "upstreams" ADD COLUMN "allow_streaming" boolean DEFAULT false NOT NULL;
