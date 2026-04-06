-- Universal Product Tracker Schema
-- PostgreSQL

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fuzzy text search

-- ─────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100),
    avatar_url      TEXT,
    subscription_status  VARCHAR(20) NOT NULL DEFAULT 'free'
                         CHECK (subscription_status IN ('free', 'paid', 'cancelled', 'past_due')),
    subscription_id      VARCHAR(255),          -- Stripe subscription ID
    stripe_customer_id   VARCHAR(255),          -- Stripe customer ID
    subscription_end_at  TIMESTAMPTZ,
    imports_used         INTEGER NOT NULL DEFAULT 0,
    push_token           TEXT,                  -- APNs device token
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Add stripe_customer_id if not present (safe to run on existing databases)
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

-- Sign in with Apple support
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id VARCHAR(255) UNIQUE;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id);

-- ─────────────────────────────────────────
-- PRODUCTS (global, shared across users)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(500) NOT NULL,
    brand           VARCHAR(255),
    description     TEXT,
    category        VARCHAR(100),
    image_url       TEXT,
    -- Canonical product identifier (e.g. ASIN, barcode, or AI-generated fingerprint)
    canonical_id    VARCHAR(255) UNIQUE,
    -- Search vector for full-text search
    search_vector   TSVECTOR,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_canonical ON products(canonical_id);
CREATE INDEX IF NOT EXISTS idx_products_search ON products USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN(name gin_trgm_ops);

-- Auto-update search vector
CREATE OR REPLACE FUNCTION products_search_vector_trigger() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.brand, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C');
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_search_update ON products;
CREATE TRIGGER products_search_update
    BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION products_search_vector_trigger();

-- ─────────────────────────────────────────
-- RETAILERS  (per product)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_retailers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    retailer_name   VARCHAR(255) NOT NULL,
    product_url     TEXT NOT NULL,
    current_price   NUMERIC(12, 2),
    currency        CHAR(3) NOT NULL DEFAULT 'GBP',
    in_stock        BOOLEAN DEFAULT TRUE,
    last_checked    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(product_id, product_url)
);

CREATE INDEX IF NOT EXISTS idx_retailers_product ON product_retailers(product_id);
CREATE INDEX IF NOT EXISTS idx_retailers_price ON product_retailers(product_id, current_price);

-- ─────────────────────────────────────────
-- PRICE HISTORY
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    retailer_id     UUID REFERENCES product_retailers(id) ON DELETE SET NULL,
    retailer_name   VARCHAR(255) NOT NULL,
    price           NUMERIC(12, 2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'GBP',
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_retailer ON price_history(retailer_id, timestamp DESC);

-- ─────────────────────────────────────────
-- PRODUCT ALTERNATIVES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_alternatives (
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alternative_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    similarity_score NUMERIC(4, 3),  -- 0.000–1.000
    reason          VARCHAR(100),     -- 'cheaper', 'same_product', 'similar', etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (product_id, alternative_id)
);

-- ─────────────────────────────────────────
-- USER PRODUCTS  (user ↔ product link)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_products (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    source_url      TEXT,           -- Original URL the user imported from
    source_type     VARCHAR(20) CHECK (source_type IN ('link', 'social', 'screenshot')),
    screenshot_url  TEXT,           -- Stored screenshot if import was image-based
    notes           TEXT,
    is_tracking     BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_user_products_user ON user_products(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_products_product ON user_products(product_id);

-- ─────────────────────────────────────────
-- BOARDS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boards (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    emoji           VARCHAR(10),
    cover_image_url TEXT,
    is_collaborative BOOLEAN DEFAULT FALSE,
    is_public       BOOLEAN DEFAULT FALSE,
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards(owner_id, sort_order);

-- Board collaborators
CREATE TABLE IF NOT EXISTS board_collaborators (
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) DEFAULT 'editor' CHECK (role IN ('viewer', 'editor')),
    invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at     TIMESTAMPTZ,
    PRIMARY KEY (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_board_collaborators_user ON board_collaborators(user_id);

-- Board invite codes (shareable links)
CREATE TABLE IF NOT EXISTS board_invites (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    code            VARCHAR(12) NOT NULL UNIQUE,
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_invites_code ON board_invites(code);

-- Migrate existing role constraint and add invite table if upgrading
ALTER TABLE board_collaborators DROP CONSTRAINT IF EXISTS board_collaborators_role_check;
ALTER TABLE board_collaborators ADD CONSTRAINT board_collaborators_role_check CHECK (role IN ('viewer', 'editor'));

-- ─────────────────────────────────────────
-- BOARD ITEMS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS board_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    added_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    position        INTEGER DEFAULT 0,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(board_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_board_items_board ON board_items(board_id, position);
CREATE INDEX IF NOT EXISTS idx_board_items_product ON board_items(product_id);

-- ─────────────────────────────────────────
-- IMPORT QUEUE  (async processing status)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_queue (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type     VARCHAR(20) NOT NULL CHECK (source_type IN ('link', 'social', 'screenshot')),
    source_url      TEXT,
    screenshot_key  TEXT,       -- S3 key if screenshot
    raw_text        TEXT,       -- OCR or scraped text
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'awaiting_confirmation', 'completed', 'failed')),
    suggestions     JSONB,      -- AI-generated product suggestions for user confirmation
    error           TEXT,
    product_id      UUID REFERENCES products(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_queue_user ON import_queue(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_queue_status ON import_queue(status);

-- ─────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL,  -- 'price_drop', 'price_up', 'lowest_ever', etc.
    product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    data            JSONB,
    sent_at         TIMESTAMPTZ,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ─────────────────────────────────────────
-- updated_at trigger helper
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at    ON users;
DROP TRIGGER IF EXISTS products_updated_at ON products;
DROP TRIGGER IF EXISTS boards_updated_at   ON boards;
DROP TRIGGER IF EXISTS imports_updated_at  ON import_queue;
CREATE TRIGGER users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER boards_updated_at   BEFORE UPDATE ON boards   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER imports_updated_at  BEFORE UPDATE ON import_queue FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================
-- Incremental migrations (safe to re-run with IF NOT EXISTS)
-- =========================================================

-- Performance index for daily price checker
CREATE INDEX IF NOT EXISTS idx_retailers_last_checked ON product_retailers(last_checked ASC NULLS FIRST);

-- Throttle retailer discovery per product (24h cooldown)
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_retailer_search_at TIMESTAMPTZ;

-- Price target alerts
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS price_target NUMERIC(12,2);

-- Discontinued product tracking
ALTER TABLE product_retailers ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_retailers ADD COLUMN IF NOT EXISTS is_discontinued BOOLEAN NOT NULL DEFAULT FALSE;

-- Universal item support (products, events, places, entertainment, recipes, etc.)
ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) CHECK (item_type IN ('product', 'place', 'entertainment', 'event', 'general'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS google_maps_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS release_year INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS streaming_platforms JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS genre VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS artist_or_director VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS event_date TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS event_venue VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ticket_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS ingredients JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS steps JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cta_label VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS cta_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS isbn VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS platform VARCHAR(100);

-- Movies & TV
ALTER TABLE products ADD COLUMN IF NOT EXISTS runtime VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS content_rating VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS cast_members JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS trailer_url TEXT;

-- Books
ALTER TABLE products ADD COLUMN IF NOT EXISTS page_count INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS publisher VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS edition VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS goodreads_url TEXT;

-- Music
ALTER TABLE products ADD COLUMN IF NOT EXISTS tracklist JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS record_label VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS pressing_info TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS condition VARCHAR(100);

-- Electronics & general products
ALTER TABLE products ADD COLUMN IF NOT EXISTS specs JSONB;

-- Places
ALTER TABLE products ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS opening_hours JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reservation_url TEXT;

-- Recipes / Food
ALTER TABLE products ADD COLUMN IF NOT EXISTS servings INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cook_time VARCHAR(100);

-- User-specific fields on user_products
-- Reading progress (Books)
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS current_page INTEGER;

-- Ingredient checklist state (Recipes)
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS checked_ingredients JSONB;

-- Clothing preferences
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS size_preference VARCHAR(50);
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS colour_preference VARCHAR(100);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_user_products_user_id       ON user_products(user_id);
CREATE INDEX IF NOT EXISTS idx_user_products_product_id    ON user_products(product_id);
CREATE INDEX IF NOT EXISTS idx_board_items_board_id        ON board_items(board_id);
CREATE INDEX IF NOT EXISTS idx_board_items_product_id      ON board_items(product_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id       ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_product_retailers_product_id ON product_retailers(product_id);
CREATE INDEX IF NOT EXISTS idx_product_retailers_price     ON product_retailers(product_id, current_price) WHERE current_price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_item_type          ON products(item_type);
CREATE INDEX IF NOT EXISTS idx_price_history_product_id    ON price_history(product_id);

-- Extended metadata fields
ALTER TABLE products ADD COLUMN IF NOT EXISTS imdb_score VARCHAR(10);
ALTER TABLE products ADD COLUMN IF NOT EXISTS rotten_tomatoes_score INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS awards JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS streaming_links JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cast_with_photos JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS book_editions JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS book_awards JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tour_dates JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS spotify_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS apple_music_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_range INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS menu_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weather_forecast JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS nutrition JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20);

-- Courses
ALTER TABLE products ADD COLUMN IF NOT EXISTS course_instructor VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS course_duration_hours NUMERIC(6,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS course_modules_count INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS certificate_available BOOLEAN;

-- Podcasts
ALTER TABLE products ADD COLUMN IF NOT EXISTS podcast_network VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS episode_count INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS latest_episode_title VARCHAR(500);

-- YouTube Videos & Articles (shared published_date)
ALTER TABLE products ADD COLUMN IF NOT EXISTS published_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS channel_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS view_count BIGINT;

-- Video Games
ALTER TABLE products ADD COLUMN IF NOT EXISTS game_platforms JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS metacritic_score INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS playtime_estimate VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS studio VARCHAR(255);

-- Wine & Spirits
ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_region VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS grape_variety VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS abv NUMERIC(4,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS tasting_notes TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS food_pairing JSONB;

-- Articles & Essays
ALTER TABLE products ADD COLUMN IF NOT EXISTS publication_name VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS read_time_minutes INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS word_count INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS article_tags JSONB;

-- Apps
ALTER TABLE products ADD COLUMN IF NOT EXISTS pricing_model VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS app_store_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS app_category VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS app_version VARCHAR(50);

-- User-specific status fields (user_products)
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS listen_status VARCHAR(20);
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS watch_status VARCHAR(20);
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS read_status VARCHAR(20);
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS game_status VARCHAR(20);
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS course_progress INTEGER;
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS cellar_quantity INTEGER;
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(12,2);
