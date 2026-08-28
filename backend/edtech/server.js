import express from "express";
import cors from "cors";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Import routes
import authRoutes from "./routes/auth.js";
import courseRoutes from "./routes/courses.js";
import { BUILTIN_COURSE_CATEGORIES } from "./constants/courseCategories.js";
import moduleRoutes from "./routes/modules.js";
import contentRoutes, { recoverInterruptedJobs } from "./routes/content.js";
import paymentRoutes from "./routes/payments.js";
import enrollmentRoutes from "./routes/enrollments.js";
import videoRoutes from "./routes/video.js";
import analyticsRoutes from "./routes/analytics.js";
import quizRoutes from "./routes/quiz.js";        // ✅ Quiz routes
import testRoutes from "./routes/test.js";        // ✅ Test routes (NEW)
import notificationRoutes from "./routes/notifications.js";
import supportRoutes from "./routes/support.js";
import homeRoutes from "./routes/home.js";
import settingsRoutes from "./routes/settings.js";
import { verifyMail } from "./utils/mailer.js";

// Import config
import pool from "./config/database.js";
import { r2Client, R2_BUCKET_NAME } from "./config/r2.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_VIDEO_DIR = path.join(__dirname, "temp_videos");

if (!fs.existsSync(TEMP_VIDEO_DIR)) {
    fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });
}

// ============================================
// Database Schema Setup
// ============================================
async function setupDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(32),
                role VARCHAR(50) DEFAULT 'student',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            INSERT INTO users (id, email, password_hash, name, role)
            VALUES ('11111111-1111-1111-1111-111111111111', 'educator@example.com', 'hashed_password', 'Default Educator', 'educator')
            ON CONFLICT (id) DO NOTHING
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                educator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                thumbnail_url TEXT,
                price DECIMAL(10,2) DEFAULT 0,
                status VARCHAR(50) DEFAULT 'draft',
                -- Nullable on purpose: 'uncategorised' is a real state, and a
                -- course with no category shows under "All" only rather than
                -- being filed under a board it may not belong to.
                category VARCHAR(64),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                deleted_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS content_items (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                title VARCHAR(512) NOT NULL,
                description TEXT,
                content_type VARCHAR(50) NOT NULL,
                file_hash VARCHAR(64) UNIQUE,
                file_name VARCHAR(512),
                file_size_bytes BIGINT,
                mime_type VARCHAR(127),
                r2_key VARCHAR(1024),
                duration_seconds INT,
                thumbnail_url TEXT,
                status VARCHAR(50) DEFAULT 'processing',
                metadata JSONB DEFAULT '{}',
                created_by UUID REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_published BOOLEAN DEFAULT TRUE,
                preview BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                deleted_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS modules (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                module_order INT DEFAULT 0,
                content_ids UUID[] DEFAULT '{}',
                is_published BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                deleted_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS payment_orders (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                order_id VARCHAR(255) UNIQUE NOT NULL,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
                amount DECIMAL(10,2),
                currency VARCHAR(3) DEFAULT 'INR',
                status VARCHAR(50) DEFAULT 'created',
                razorpay_payment_id VARCHAR(255) UNIQUE,
                razorpay_signature VARCHAR(512),
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        /*
         * enrollments and folders were never created here.
         *
         * Both are read and written all over the codebase, but the only
         * statement that mentioned enrollments was an ALTER adding expires_at.
         * On the production database that works, because the tables were made
         * by hand at some point; on a fresh one the ALTER throws, the catch
         * below swallows it, and every enrolment query fails afterwards with a
         * "relation does not exist" that looks nothing like the real cause.
         *
         * That made the schema impossible to stand up from scratch — which is
         * to say, impossible to develop against anything but production.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS enrollments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                status VARCHAR(50) DEFAULT 'pending',
                payment_status VARCHAR(50) DEFAULT 'pending',
                payment_id VARCHAR(255),
                amount_paid DECIMAL(10,2) DEFAULT 0,
                enrolled_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ DEFAULT NULL,
                last_accessed TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                -- Required: the purchase and renewal paths both rely on
                -- ON CONFLICT (user_id, course_id) to re-activate a lapsed
                -- enrolment rather than inserting a second row.
                UNIQUE (user_id, course_id)
            )
        `);

        // Tabs within a module. content_items, quizzes and test_files all carry
        // a folder_id pointing here.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS folders (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Installs that predate this block may lack the newer columns.
        await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ`);
        await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
        await pool.query(`ALTER TABLE content_items ADD COLUMN IF NOT EXISTS folder_id UUID`);
        await pool.query(`ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS folder_id UUID`);
        await pool.query(`ALTER TABLE content_items ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS video_progress (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
                course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                position INT DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, content_id)
            )
        `);

        // ============================================
        // QUIZ TABLES
        // ============================================
        await pool.query(`
            CREATE TABLE IF NOT EXISTS quizzes (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                module_id UUID REFERENCES modules(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                created_by UUID REFERENCES users(id),
                folder_id UUID DEFAULT NULL,
                time_limit INT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS quiz_questions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                quiz_id UUID REFERENCES quizzes(id) ON DELETE CASCADE,
                question_text TEXT NOT NULL,
                options JSONB NOT NULL,
                correct_option_index INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // ============================================
        // QUIZ ATTEMPT TABLES
        // ============================================
        await pool.query(`
            CREATE TABLE IF NOT EXISTS quiz_attempts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                score DECIMAL(5,2) DEFAULT 0,
                total_questions INT DEFAULT 0,
                correct_answers INT DEFAULT 0,
                answers JSONB DEFAULT '{}',
                time_taken INT DEFAULT 0,
                status VARCHAR(50) DEFAULT 'completed',
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(quiz_id, user_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS quiz_answers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                attempt_id UUID NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
                question_id UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
                selected_option INT,
                is_correct BOOLEAN DEFAULT FALSE,
                answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(attempt_id, question_id)
            )
        `);

        // ============================================
        // TEST FILES TABLE
        // ============================================
        await pool.query(`
            CREATE TABLE IF NOT EXISTS test_files (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                module_id UUID REFERENCES modules(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                file_name VARCHAR(512) NOT NULL,
                file_size_bytes BIGINT,
                r2_key VARCHAR(1024) NOT NULL,
                folder_id UUID DEFAULT NULL,
                status VARCHAR(50) DEFAULT 'ready',
                created_by UUID REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE
            )
        `);

        // ============================================
        // INDEXES
        // ============================================
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_modules_course_id ON modules(course_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_items_hash ON content_items(file_hash)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_courses_educator_id ON courses(educator_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_orders_order_id ON payment_orders(order_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_progress_user_content ON video_progress(user_id, content_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_quizzes_module_id ON quizzes(module_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz_id ON quiz_questions(quiz_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz_id ON quiz_attempts(quiz_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_id ON quiz_attempts(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_answers_attempt_id ON quiz_answers(attempt_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_files_module_id ON test_files(module_id)`);

        // CREATE TABLE IF NOT EXISTS does nothing to a table that already
        // exists, so new columns need an explicit ALTER or every existing
        // database silently lacks them.
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32)`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

        // ============================================
        // STUDENT DETAILS
        // ============================================
        /*
         * Email stops being mandatory.
         *
         * Students sign up with a mobile number; an email address is optional
         * and many will not have one. The column stays UNIQUE, so two accounts
         * still cannot share an address — Postgres permits any number of NULLs
         * in a unique index, which is exactly the behaviour wanted here.
         */
        await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);

        /*
         * Phone becomes a login identifier, so it has to be unique.
         *
         * A partial index rather than a plain UNIQUE constraint: every account
         * created before this feature has phone NULL, and while Postgres would
         * tolerate those duplicates anyway, being explicit documents that only
         * real numbers are constrained.
         */
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
                ON users(phone) WHERE phone IS NOT NULL
        `);

        // Academic profile. All nullable: educators do not have a class, and
        // accounts created before this shipped have none of it.
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS class_level VARCHAR(20)`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS board VARCHAR(40)`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS state VARCHAR(80)`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS school VARCHAR(255)`);

        // Quizzes need a sort key so they can be interleaved with PDFs and
        // videos in one ordered list. content_items already has `priority`;
        // this gives quizzes the same field so both sort together.
        await pool.query(`ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0`);

        // Manual course ordering on the educator dashboard. Course creation
        // now writes MAX + 1 into this, so a missing column would fail every
        // insert rather than just disabling the reorder arrows.
        await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0`);

        // Per-quiz shuffling, teacher-controlled. Default true so quizzes that
        // already exist keep the anti-copying behaviour rather than silently
        // reverting to a fixed order when this ships.
        await pool.query(`ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS shuffle_questions BOOLEAN DEFAULT true`);
        await pool.query(`ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS shuffle_options BOOLEAN DEFAULT true`);

        // Timed access. NULL on both means unlimited, so every existing course
        // and every enrolment already sold keeps working untouched.
        await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS access_duration_months INT DEFAULT NULL`);
        /*
         * TIMESTAMPTZ, not TIMESTAMP.
         *
         * A bare TIMESTAMP stores a wall-clock reading with no zone attached.
         * Postgres then evaluates `expires_at > NOW()` using the database
         * session's zone, while the browser reads the serialised value as an
         * instant in its own — so the server could report "access until today"
         * for a row the student's browser had already shown as expired. The
         * two disagreed by exactly the offset between them.
         *
         * An expiry is a moment in time, not a wall-clock reading, so it needs
         * a type that says which moment.
         */
        await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL`);

        /*
         * Convert installs created before the type was corrected.
         *
         * The old values must be interpreted in the NODE process's zone, not
         * the database's. node-postgres serialises a JS Date to a local
         * wall-clock string, and a naive TIMESTAMP column keeps exactly that —
         * so the reading was recorded in the app server's zone. Converting
         * with the database's zone instead shifts every row by the offset
         * between them, which on an IST app server against a UTC database
         * pushed every expiry 5.5 hours into the future and stopped anything
         * expiring at all.
         */
        const nodeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'enrollments'
                      AND column_name = 'expires_at'
                      AND data_type = 'timestamp without time zone'
                ) THEN
                    ALTER TABLE enrollments
                        ALTER COLUMN expires_at TYPE TIMESTAMPTZ
                        USING expires_at AT TIME ZONE ${JSON.stringify(nodeZone).replace(/"/g, "'")};
                END IF;
            END $$;
        `);
        // Short-duration override, so the expiry behaviour can be verified
        // without waiting a calendar month. Takes precedence over months.
        await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS access_duration_minutes INT DEFAULT NULL`);
        // Every access check filters on it, and it is the column that decides
        // whether a student can open a paid course.
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_enrollments_expires_at ON enrollments(expires_at)`);

        /*
         * Stamped the first time a course is announced to students.
         *
         * Publishing is a toggle, and a teacher fixing a typo may well
         * unpublish and republish several times. Without a record that the
         * announcement already went out, every one of those flips would push a
         * fresh notification to every student on the platform.
         *
         * NULL means "never announced", which is the correct starting state
         * for courses that already exist — they are not new to anyone.
         */
        await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ DEFAULT NULL`);

        /*
         * Drives the filter chips on the student home screen.
         *
         * VARCHAR(64) rather than an enum type: the list of boards will change
         * (a new exam, a new state board) and adding a value to a Postgres enum
         * is a migration, whereas adding one to the shared JS constant is a
         * one-line change validated in the API.
         */
        await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS category VARCHAR(64) DEFAULT NULL`);

        /*
         * The categories themselves, so teachers can add their own.
         *
         * The five built-ins used to be a hardcoded list in two files. That is
         * fine until a school needs "Rajasthan Board" or "Foundation" — then
         * adding one means a code change and a deploy.
         *
         * A table rather than free text on the course. The id is a slug, so
         * "HP Board", "HP board" and "hp  board" all collapse to hp_board
         * instead of becoming three chips that each hide two thirds of the
         * courses. The label is stored once here rather than per course, so
         * two courses cannot disagree about how the same category is spelled.
         *
         * No foreign key from courses.category. Existing rows hold ids that
         * predate this table, and a constraint would reject them at migration
         * time — a chip pointing at a deleted category is a cosmetic problem,
         * a failed boot is not.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS course_categories (
                id VARCHAR(64) PRIMARY KEY,
                label VARCHAR(64) NOT NULL,
                -- Built-ins cannot be renamed or removed by a teacher: the
                -- frontend ships them for first paint, so a renamed one would
                -- read differently before and after the page finished loading.
                is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
                created_by UUID REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        /*
         * Seeded idempotently. ON CONFLICT DO UPDATE rather than DO NOTHING so
         * a corrected built-in label reaches an existing database, which
         * DO NOTHING would silently skip.
         */
        /*
         * The order the chips appear in, which a teacher can change.
         *
         * Seeded from the shipped array's own order so an existing database
         * keeps the arrangement it already had, rather than jumping to
         * alphabetical the moment this column appears.
         */
        await pool.query(`ALTER TABLE course_categories ADD COLUMN IF NOT EXISTS sort_order INT`);
        await pool.query(`
            UPDATE course_categories SET sort_order = 1000
             WHERE sort_order IS NULL AND is_builtin = FALSE
        `);

        for (const c of BUILTIN_COURSE_CATEGORIES) {
            /*
             * sort_order is set on insert only, never on conflict: re-seeding
             * on every boot would undo a teacher's arrangement each restart.
             */
            await pool.query(
                `INSERT INTO course_categories (id, label, is_builtin, sort_order)
                      VALUES ($1, $2, TRUE, $3)
                 ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, is_builtin = TRUE`,
                [c.id, c.label, BUILTIN_COURSE_CATEGORIES.indexOf(c)]
            );
        }

        /*
         * Personal appearance override.
         *
         * All four are nullable, and null is meaningful: it means "follow
         * whatever the school has set". A default of 'default' would be wrong
         * — it would pin every existing account to one palette the moment this
         * column appeared, and a teacher changing the platform theme would
         * then have no effect on anyone.
         *
         * Separate from platform_settings on purpose. That table is one row
         * for the whole site and only educators may write it; these columns
         * are per-account and every user owns their own.
         */
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_theme VARCHAR(64) DEFAULT NULL`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_mode VARCHAR(32) DEFAULT NULL`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_density VARCHAR(32) DEFAULT NULL`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_style VARCHAR(32) DEFAULT NULL`);
        // The home screen filters on it and nothing else selects by it, so one
        // partial index over the rows that actually have a value is enough.
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_courses_category ON courses(category) WHERE category IS NOT NULL`);

        /*
         * Backfill: everything already published pre-dates this feature.
         *
         * Without this, the first publish-toggle on any existing course would
         * announce it as new, and a teacher tidying up their catalogue could
         * notify every student about a course that has been up for months.
         */
        await pool.query(`
            UPDATE courses
               SET announced_at = COALESCE(updated_at, created_at, NOW())
             WHERE announced_at IS NULL
               AND status = 'published'
        `);

        // ============================================
        // PASSWORD RESET
        // ============================================
        /*
         * The OTP is stored hashed, like a password.
         *
         * A reset code is a temporary credential: anyone holding it can take
         * the account. Storing it in plain text means a leaked database dump —
         * or a stray log of a query — hands over every in-flight reset. bcrypt
         * costs a few milliseconds on a route nobody hits in a loop.
         *
         * `attempts` caps guessing: six digits is a million combinations, which
         * is a lot for a human and nothing for a script.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                code_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                attempts INT DEFAULT 0,
                consumed_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Every lookup is "the newest live reset for this user".
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_password_resets_user
                ON password_resets(user_id, created_at DESC)
        `);

        /*
         * Clear out anything long dead on boot.
         *
         * Codes are useless minutes after they are issued, but the rows would
         * otherwise accumulate for the life of the install — and every one of
         * them is a bcrypt hash of a credential that no longer needs to exist.
         */
        await pool.query(`DELETE FROM password_resets WHERE created_at < NOW() - INTERVAL '7 days'`);

        // ============================================
        // EMAIL VERIFICATION
        // ============================================
        /*
         * A separate table from password_resets, not a `purpose` column on it.
         *
         * The two look alike but differ where it matters: a reset code lets
         * someone take over an account, a verification code only confirms an
         * address they already control. Sharing a table would mean one query
         * bug could let a verification code be spent as a reset — the kind of
         * mistake that is invisible until it is exploited.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS email_verifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                email VARCHAR(255) NOT NULL,
                code_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                attempts INT DEFAULT 0,
                consumed_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_email_verifications_user
                ON email_verifications(user_id, created_at DESC)
        `);

        await pool.query(`DELETE FROM email_verifications WHERE created_at < NOW() - INTERVAL '7 days'`);

        /*
         * Codes sent to an address before any account exists.
         *
         * Keyed by email, not user_id — that is the whole difference. The
         * address is confirmed during signup, while the person is still filling
         * in the form, so there is no row in `users` to hang the code off yet.
         *
         * Rows here are not evidence of an account and must never be treated as
         * such: a completed verification produces a short-lived signed proof,
         * and the proof is what registration accepts.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS signup_email_verifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) NOT NULL,
                code_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                attempts INT DEFAULT 0,
                consumed_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_signup_email_verifications_email
                ON signup_email_verifications(email, created_at DESC)
        `);
        /*
         * Which kind of account the code was requested for.
         *
         * Bound to the row, not just the request, because the proof handed out
         * on success carries it. Without that, someone could confirm a student
         * code for their own address and then post it to /register asking for
         * an educator account — the proof would be perfectly valid, and the
         * approval step would be decoration.
         */
        await pool.query(
            `ALTER TABLE signup_email_verifications
             ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'student'`
        );


        await pool.query(`DELETE FROM signup_email_verifications WHERE created_at < NOW() - INTERVAL '2 days'`);

        /*
         * The address is stored on the verification row as well as the user.
         *
         * Without it, a code issued for one address could be redeemed after
         * the address changed, marking the new one verified on the strength of
         * an email sent to the old one.
         */
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);

        /*
         * When the person closed their own account.
         *
         * Deletion anonymises rather than removing the row: enrolment and
         * payment records point at it, and losing those means a refund dispute
         * months later has nothing to check against. The identifying columns
         * are scrubbed and this timestamp records that it happened.
         *
         * It is also the flag every sign-in path checks. A scrubbed row still
         * has a password hash — a random one nobody holds — so this is what
         * makes "the account is gone" a stated rule rather than an accident of
         * the hash being unguessable.
         */
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`);

        /*
         * Everyone who already has an account keeps it usable.
         *
         * Existing accounts were created before verification existed, so their
         * addresses are unverified by definition — but flagging them all would
         * put a warning banner in front of every current user for something
         * they had no way to do. They are grandfathered in; the requirement
         * applies to accounts created from here on.
         */
        await pool.query(`
            UPDATE users SET email_verified = TRUE
             WHERE email IS NOT NULL AND email_verified IS NOT TRUE
               AND created_at < NOW()
        `);

        // ============================================
        // PLATFORM APPEARANCE
        // ============================================
        /*
         * One row, enforced by a CHECK on a constant primary key.
         *
         * These are platform-wide settings, not per-user preferences — a second
         * row would mean two answers to "what does the site look like" with
         * nothing to say which wins. The constraint makes that unrepresentable
         * rather than merely discouraged.
         */
        /*
         * Widths sized to the longest allowed value, not guessed.
         *
         * density was VARCHAR(10) and "comfortable" is eleven characters, so
         * inserting the default row failed with "value too long" — and because
         * setupDatabase catches its own errors, the failure appeared as a log
         * line while everything after it in this block silently never ran.
         *
         * The allowed values live in routes/settings.js; if any gains a longer
         * option these need widening to match. 32 leaves room to do that
         * without another migration.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS platform_settings (
                id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                theme VARCHAR(40) DEFAULT 'default',
                mode VARCHAR(32) DEFAULT 'light',
                density VARCHAR(32) DEFAULT 'comfortable',
                updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        /*
         * Widen columns on installs created before the fix.
         *
         * CREATE TABLE IF NOT EXISTS does nothing to a table that already
         * exists, so a database that got the narrow version keeps it — and
         * every attempt to save "comfortable" would go on failing.
         */
        await pool.query(`ALTER TABLE platform_settings ALTER COLUMN mode TYPE VARCHAR(32)`);
        await pool.query(`ALTER TABLE platform_settings ALTER COLUMN density TYPE VARCHAR(32)`);

        /*
         * The visual language, separate from the palette.
         *
         * 'brutal' is what the app was built in and stays the default, so
         * nothing changes for an existing install until someone chooses
         * otherwise.
         */
        await pool.query(
            `ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS style VARCHAR(32) DEFAULT 'brutal'`
        );

        // Seed the single row so reads never have to cope with its absence.
        await pool.query(`
            INSERT INTO platform_settings (id, theme, mode, density, style)
            VALUES (1, 'eduverse', 'light', 'comfortable', 'soft')
            ON CONFLICT (id) DO NOTHING
        `);

        // ============================================
        // NOTIFICATIONS
        // ============================================
        /*
         * One row per recipient, not one row per event.
         *
         * The alternative — a single announcement row plus a join table of who
         * has read it — saves storage but makes every read expensive: the
         * unread badge, which polls, would need an anti-join against the read
         * table on each poll. Fanning out at write time means the badge is a
         * single indexed COUNT, and per-user state (read, dismissed) has an
         * obvious home. Writes are rare; reads happen every minute per user.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
                type VARCHAR(40) NOT NULL,
                title VARCHAR(255) NOT NULL,
                body TEXT,
                course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
                link TEXT,
                read_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // The feed query is "my notifications, newest first"; the badge is
        // "my unread count". Both are covered here.
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_notifications_user_created
                ON notifications(user_id, created_at DESC)
        `);
        // Partial index: only unread rows are ever counted, and read rows
        // accumulate indefinitely, so indexing them wastes space.
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_notifications_unread
                ON notifications(user_id) WHERE read_at IS NULL
        `);

        // ============================================
        // SUPPORT TICKETS
        // ============================================
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                subject VARCHAR(255) NOT NULL,
                category VARCHAR(40) DEFAULT 'other',
                course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
                status VARCHAR(20) DEFAULT 'open',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        /*
         * The opening message is stored here too, rather than as a `body`
         * column on the ticket. A thread whose first entry lives in a
         * different table than the rest needs special-casing at every render
         * and every ordering; one uniform list does not.
         */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_ticket_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_user
                ON support_tickets(user_id, created_at DESC)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
                ON support_ticket_messages(ticket_id, created_at)
        `);

        console.log("✅ Database schema ready");
    } catch (err) {
        console.error("❌ Database setup error:", err);
    }
}

setupDatabase()
    // Only after the schema is in place: the recovery reads content_items and
    // would race the migrations on a first boot.
    .then(() => recoverInterruptedJobs())
    .catch((err) => console.error("Startup tasks failed:", err));

// ============================================
// CORS Middleware (MUST BE FIRST!)
// ============================================
const corsOptions = {
    origin: ['http://localhost:5173', 'http://localhost:3000', 'https://sv.gridsphere.in', 'http://localhost:5174'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors({
    origin: true, // ✅ Dynamically reflects the incoming request origin (bulletproof for dev & prod)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// ============================================
// Body Parsers & Security Headers
// ============================================
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/temp_videos', express.static(path.join(__dirname, 'temp_videos')));

app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self' http://localhost:5173 https://sv.gridsphere.in");
    next();
});

// ============================================
// Routes
// ============================================
app.use("/api/auth", authRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/modules", moduleRoutes);
app.use("/api/content", contentRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/enrollments", enrollmentRoutes);
app.use("/api/video", videoRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/quiz", quizRoutes);      // ✅ Quiz routes
app.use("/api/test", testRoutes);      // ✅ Test routes (NEW)
app.use("/api/notifications", notificationRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/settings", settingsRoutes);

// ============================================
// HLS Proxy Route
// ============================================
app.get("/api/hls/serve", async (req, res) => {
    try {
        const { videoId, path: hlsPathRaw } = req.query;
        if (!videoId || !hlsPathRaw) return res.status(400).send("Missing videoId or path");

        const hlsPath = hlsPathRaw;
        if (hlsPath.includes("..")) return res.status(400).send("Invalid path");

        const result = await pool.query(
            `SELECT r2_key, status FROM content_items WHERE id = $1`,
            [videoId]
        );
        if (result.rows.length === 0) return res.status(404).send("Content not found");

        const content = result.rows[0];
        if (content.status !== "ready") return res.status(202).send("Video still processing");
        if (!content.r2_key) return res.status(404).send("Manifest not found");

        const r2Base = content.r2_key.replace(/\/master\.m3u8$/, "");
        const r2Key = hlsPath === "master.m3u8" ? content.r2_key : `${r2Base}/${hlsPath}`;

        console.log(`HLS: ${videoId} → ${r2Key}`);

        let r2Response;
        try {
            const { GetObjectCommand } = await import("@aws-sdk/client-s3");
            r2Response = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: r2Key }));
        } catch (err) {
            if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
                console.error(`R2 not found: ${r2Key}`);
                return res.status(404).send(`Not found: ${hlsPath}`);
            }
            throw err;
        }

        const isM3u8 = hlsPath.endsWith(".m3u8");
        const isTs = hlsPath.endsWith(".ts");

        res.setHeader("Content-Type",
            isM3u8 ? "application/vnd.apple.mpegurl"
                : isTs ? "video/mp2t"
                    : "application/octet-stream"
        );
        res.setHeader("Cache-Control", "no-cache, no-store, private");
        res.setHeader("Access-Control-Allow-Origin", "*");
        
        if (r2Response.ContentLength) {
            res.setHeader("Content-Length", r2Response.ContentLength);
        }
        if (isTs) {
            r2Response.Body.pipe(res);
            return;
        }

        const chunks = [];
        for await (const chunk of r2Response.Body) chunks.push(chunk);
        let manifest = Buffer.concat(chunks).toString("utf-8");

        const currentDir = hlsPath.includes("/")
            ? hlsPath.substring(0, hlsPath.lastIndexOf("/") + 1)
            : "";

        const rewritten = manifest.split("\n").map(line => {
            const t = line.trim();
            if (!t || t.startsWith("#")) return line;
            if (t.startsWith("/api/") || t.startsWith("http")) return line;

            const fullPath = currentDir + t;
            return `/api/hls/serve?videoId=${videoId}&path=${encodeURIComponent(fullPath)}`;
        });

        res.send(rewritten.join("\n"));

    } catch (err) {
        console.error("HLS proxy error:", err);
        res.status(500).send("Proxy error: " + err.message);
    }
});

// ============================================
// Monitoring & Health
// ============================================
app.get("/api/transcode/active", (req, res) => {
    res.json({ success: true, activeJobs: [], count: 0 });
});

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ok", database: "connected", r2: "configured" });
    } catch (err) {
        res.status(500).json({ status: "error", database: "disconnected", error: err.message });
    }
});

// ============================================
// Error Handling
// ============================================
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error", message: err.message });
});

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Temp:   ${TEMP_VIDEO_DIR}`);
    console.log(`☁️  R2:     ${R2_BUCKET_NAME}`);
    console.log(`📁 Routes loaded:`);
    console.log(`   - /api/auth`);
    console.log(`   - /api/courses`);
    console.log(`   - /api/modules`);
    console.log(`   - /api/content`);
    console.log(`   - /api/payments`);
    console.log(`   - /api/enrollments`);
    console.log(`   - /api/video`);
    console.log(`   - /api/analytics`);
    console.log(`   - /api/quiz`);
    console.log(`   - /api/test`);  // ✅ Added test route
    console.log(`   - /api/notifications`);
    console.log(`   - /api/support`);

    /*
     * Configuration the operator needs to know about, reported at boot.
     *
     * Both of these degrade quietly rather than failing: without SMTP a reset
     * code goes to this log instead of an inbox, and without Razorpay the paid
     * checkout returns "not available". Neither produces an error anyone would
     * notice until a user reports it, so they are surfaced here where the
     * person who can fix them is already looking.
     */
    console.log("");
    console.log(`💳 Payments: ${process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? "enabled" : "DISABLED — free courses still work"}`);

    /*
     * Authenticate against the mail server at boot.
     *
     * Without this, wrong SMTP credentials are only discovered when a student
     * requests a reset code that never arrives — and the failure is a log line
     * nobody is watching, because the UI reports success either way (it has to:
     * telling the caller whether an address exists would leak who is
     * registered).
     *
     * Deliberately not awaited: mail is not required for the server to serve
     * requests, and a slow or unreachable SMTP host should not delay startup.
     */
    verifyMail().then((result) => {
        if (!result.configured) {
            console.log(`✉️  Email:   NOT CONFIGURED — reset codes print to this log`);
        } else if (result.ok) {
            console.log(`✉️  Email:   ✅ connected to ${process.env.SMTP_HOST} as ${process.env.SMTP_USER}`);
        } else {
            console.log(
                `\n${"=".repeat(70)}\n` +
                `❌ Email:   SMTP is configured but the login was REJECTED.\n` +
                `   Password reset codes will not be delivered.\n\n` +
                `${result.error}\n\n` +
                `   Raw error: ${result.raw}\n` +
                `${"=".repeat(70)}`
            );
        }
        console.log(`${"=".repeat(70)}\n`);
    });
});