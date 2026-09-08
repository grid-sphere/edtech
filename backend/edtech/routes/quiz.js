import express from "express";
import pool from "../config/database.js";
import authMiddleware, { canManage } from "../middleware/auth.js";
import {
    seededPermutation,
    invertPermutation,
    questionOrderSeed,
    optionOrderSeed,
} from "../utils/quizShuffle.js";
import { notifyCourseStudents, notifyCourseOwner, courseIdForModule } from "../utils/notify.js";

const router = express.Router();

/**
 * Single source of truth for "may this user use this quiz?".
 *
 * This existed in three copies with three different rules, which is why an
 * educator could open a quiz but not submit it:
 *
 *   GET  /:quizId        if (!isOwner && req.user.role === 'student')  <- exempted educators
 *   POST /:quizId/answer if (!isOwner)                                 <- did not
 *   POST /:quizId/submit if (!isOwner)                                 <- did not
 *
 * The rule: owners and admins always pass, other educators may take a quiz to
 * preview it, students must hold an active enrolment.
 *
 * @returns {{ok: true, courseId: string, isOwner: boolean}
 *          | {ok: false, status: number, error: string}}
 */
async function checkQuizAccess(db, quizId, user) {
    const meta = await db.query(`
        SELECT m.course_id, c.educator_id, c.title, c.parent_course_id
        FROM quizzes q
        JOIN modules m ON q.module_id = m.id
        JOIN courses c ON m.course_id = c.id
        WHERE q.id = $1
    `, [quizId]);

    if (meta.rows.length === 0) {
        return { ok: false, status: 404, error: "Quiz not found" };
    }

    const {
        course_id: courseId,
        educator_id: educatorId,
        title: courseTitle,
        parent_course_id: parentCourseId,
    } = meta.rows[0];

    const isOwner = educatorId === user.id;

    if (isOwner || user.role === 'admin' || user.role === 'educator') {
        return { ok: true, courseId, isOwner };
    }

    // Courses nest: a quiz can live in a sub-course while the student enrolled
    // in the parent. Accept either, or access breaks for every sub-course quiz.
    const courseIds = parentCourseId ? [courseId, parentCourseId] : [courseId];

    const rows = await db.query(
        `SELECT course_id, status, payment_status, expires_at FROM enrollments
         WHERE user_id = $1 AND course_id = ANY($2::uuid[])`,
        [user.id, courseIds]
    );

    // Filtered in JS here rather than SQL, so expiry has to be applied by hand.
    const valid = (r) =>
        r.status === 'active' && (!r.expires_at || new Date(r.expires_at) > new Date());

    if (rows.rows.some(valid)) {
        return { ok: true, courseId, isOwner };
    }

    // A lapsed enrolment is a different problem from never having enrolled, and
    // the student can fix it themselves — say so instead of "not enrolled".
    const lapsed = rows.rows.find(
        (r) => r.status === 'active' && r.expires_at && new Date(r.expires_at) <= new Date()
    );
    if (lapsed) {
        return {
            ok: false,
            status: 403,
            error: `Your access to "${courseTitle}" expired on ` +
                   `${new Date(lapsed.expires_at).toLocaleDateString()}. Renew it to continue.`,
            expired: true,
        };
    }

    // Say what is actually wrong. "You must be enrolled" is unhelpful — and
    // wrong — when the row exists but is sitting at 'pending' because a
    // payment never completed.
    const found = rows.rows[0];
    const error = found
        ? `Your enrolment in "${courseTitle}" is "${found.status}"` +
          (found.payment_status ? ` (payment: ${found.payment_status})` : '') +
          `. It must be active to take this quiz.`
        : `You are not enrolled in "${courseTitle}".`;

    return {
        ok: false,
        status: 403,
        error,
        debug: { courseId, parentCourseId, userId: user.id, enrollments: rows.rows },
    };
}

// ============================================================
// CREATE QUIZ
// ============================================================
router.post("/create", authMiddleware, async (req, res) => {
    const {
        moduleId, title, description, questions, folder_id, time_limit,
        shuffle_questions, shuffle_options,
    } = req.body;

    if (!moduleId || !title || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "moduleId, title and at least one question are required" });
    }

    /*
     * Optional per-quiz time limit, in whole minutes.
     *
     * Null means untimed, which is the default and what every existing quiz
     * has. Validated rather than passed straight through: a zero or negative
     * limit would produce a quiz that is over before it starts, and a huge
     * value is more likely a typo (600 for "6:00") than an intended ten-hour
     * exam. The cap is generous enough for a real paper.
     */
    let minutes = null;
    if (time_limit !== undefined && time_limit !== null && time_limit !== "") {
        minutes = Number(time_limit);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
            return res.status(400).json({
                error: "Time limit must be a whole number of minutes between 1 and 480, or left empty for no limit.",
            });
        }
    }

    // Absent means "on": the checkboxes default to ticked, and an older client
    // that does not send them should not quietly disable shuffling.
    const shuffleQuestions = shuffle_questions !== false;
    const shuffleOptions = shuffle_options !== false;

    const moduleCheck = await pool.query(`
        SELECT c.educator_id
        FROM modules m
        JOIN courses c ON m.course_id = c.id
        WHERE m.id = $1 AND m.is_active = true
    `, [moduleId]);

    if (moduleCheck.rows.length === 0) {
        return res.status(404).json({ error: "Module not found" });
    }
    if (!canManage(moduleCheck.rows[0].educator_id, req.user)) {
        return res.status(403).json({ error: "Only the course creator or an admin can add quizzes" });
    }

    for (const q of questions) {
        if (!q.question_text || !Array.isArray(q.options) || q.options.length < 2) {
            return res.status(400).json({ error: "Each question needs text and at least 2 options" });
        }
        if (
            typeof q.correct_option_index !== "number" ||
            q.correct_option_index < 0 ||
            q.correct_option_index >= q.options.length
        ) {
            return res.status(400).json({ error: "Each question needs a valid correct_option_index" });
        }
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const quizResult = await client.query(`
            INSERT INTO quizzes (
                module_id, title, description, created_by, folder_id, time_limit,
                shuffle_questions, shuffle_options
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
        `, [
            moduleId, title, description || "", req.user.id, folder_id || null, minutes,
            shuffleQuestions, shuffleOptions,
        ]);

        const quiz = quizResult.rows[0];

        for (const q of questions) {
            await client.query(`
                INSERT INTO quiz_questions (quiz_id, question_text, options, correct_option_index, image_url)
                VALUES ($1, $2, $3, $4, $5)
            `, [quiz.id, q.question_text, JSON.stringify(q.options), q.correct_option_index, q.image_url || null]);
        }

        await client.query("COMMIT");

        // After COMMIT and before the response: students are told about a quiz
        // that definitely exists, and a notification failure cannot roll back
        // the quiz the teacher just spent time building.
        const courseId = await courseIdForModule(moduleId);
        await notifyCourseStudents(courseId, {
            type: "quiz",
            title: "New quiz added",
            body: title,
            actorId: req.user.id,
            link: `/course/${courseId}`,
        });

        res.status(201).json({ success: true, quiz });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Quiz create error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// Helper: get-or-restart the single attempt row a user has for a quiz.
// The schema only allows ONE quiz_attempts row per (quiz_id, user_id)
// (UNIQUE constraint), so this always upserts onto that same row instead
// of ever trying to INSERT a fresh one when one already exists.
// ============================================================
async function getOrRestartAttempt(client, quizId, userId) {
    const result = await client.query(`
        INSERT INTO quiz_attempts (quiz_id, user_id, status, started_at)
        VALUES ($1, $2, 'in_progress', NOW())
        ON CONFLICT (quiz_id, user_id)
        DO UPDATE SET
            status = 'in_progress',
            started_at = NOW(),
            completed_at = NULL,
            score = NULL,
            correct_answers = 0,
            updated_at = NOW()
        WHERE quiz_attempts.status <> 'in_progress'
        RETURNING id
    `, [quizId, userId]);

    if (result.rows.length > 0) {
        return result.rows[0].id;
    }

    const existing = await client.query(`
        SELECT id FROM quiz_attempts WHERE quiz_id = $1 AND user_id = $2
    `, [quizId, userId]);
    return existing.rows[0].id;
}

// ============================================================
// SUBMIT QUIZ ANSWER (per question)
// ============================================================
router.post("/:quizId/answer", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { quizId } = req.params;
        const { questionId, selectedOption } = req.body;
        const userId = req.user.id;

        const quizCheck = await client.query(`
            SELECT c.id AS course_id, c.educator_id 
            FROM quizzes q
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE q.id = $1
        `, [quizId]);

        if (quizCheck.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: "Quiz not found" });
        }

        const access = await checkQuizAccess(client, quizId, req.user);
        if (!access.ok) {
            if (access.debug) console.warn("[quiz] access denied:", access.error, access.debug);
            client.release();
            return res.status(access.status).json({ error: access.error });
        }

        const questionResult = await client.query(`
            SELECT id, correct_option_index
            FROM quiz_questions
            WHERE id = $1 AND quiz_id = $2
        `, [questionId, quizId]);

        if (questionResult.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: "Question not found" });
        }

        const question = questionResult.rows[0];
        const isCorrect = selectedOption === question.correct_option_index;

        await client.query("BEGIN");

        const attemptId = await getOrRestartAttempt(client, quizId, userId);

        await client.query(`
            INSERT INTO quiz_answers (attempt_id, question_id, selected_option, is_correct, answered_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (attempt_id, question_id) 
            DO UPDATE SET 
                selected_option = EXCLUDED.selected_option,
                is_correct = EXCLUDED.is_correct,
                answered_at = NOW()
        `, [attemptId, questionId, selectedOption, isCorrect]);

        await client.query(`
            UPDATE quiz_attempts 
            SET correct_answers = (
                SELECT COUNT(*) FROM quiz_answers 
                WHERE attempt_id = $1 AND is_correct = true
            ),
            total_questions = (
                SELECT COUNT(*) FROM quiz_questions 
                WHERE quiz_id = $2
            ),
            updated_at = NOW()
            WHERE id = $1
        `, [attemptId, quizId]);

        await client.query("COMMIT");

        res.json({
            success: true,
            isCorrect,
            attemptId
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Quiz answer error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// SUBMIT QUIZ (finalize)
// 🌟 UPDATED: now also returns `stats` -- rank, percentile, accuracy,
// attempt % (across the course's quizzes), and time taken -- all scoped
// to students enrolled in this quiz's course, based on this quiz's score.
//
// 🌟 TIME-TAKEN FIX: `quiz_attempts.started_at` only ever gets set the
// moment this route (or /answer, which the frontend doesn't call) upserts
// the attempt row -- so DB-based `completed_at - started_at` was always
// ~0s (the row didn't exist while the student was actually answering).
// Frontend now tracks real open->submit time on the client and sends it
// as `clientTimeTakenSeconds`. We trust that value when it's present and
// sane, and only fall back to the DB timestamps if it's missing/invalid.
// ============================================================
router.post("/:quizId/submit", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { quizId } = req.params;
        const userId = req.user.id;
        const { answers, clientTimeTakenSeconds } = req.body;

        if (!answers || typeof answers !== "object") {
            client.release();
            return res.status(400).json({ error: "answers object is required" });
        }

        const quizMeta = await client.query(`
            SELECT m.course_id, c.educator_id
            FROM quizzes q
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE q.id = $1
        `, [quizId]);

        if (quizMeta.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: "Quiz not found" });
        }

        const access = await checkQuizAccess(client, quizId, req.user);
        if (!access.ok) {
            if (access.debug) console.warn("[quiz] access denied:", access.error, access.debug);
            client.release();
            return res.status(access.status).json({ error: access.error });
        }
        const courseId = access.courseId;
        const isOwner = access.isOwner;

        /*
         * Grading has to use exactly the shuffle the serve route used. Reading
         * the flags here rather than assuming them is the difference between
         * translating the student's choice correctly and silently marking a
         * whole class wrong the moment a teacher turns shuffling off.
         */
        const flagsResult = await client.query(
            `SELECT shuffle_questions, shuffle_options FROM quizzes WHERE id = $1`,
            [quizId]
        );
        const flags = flagsResult.rows[0] || {};
        const shuffleQ = !isOwner && flags.shuffle_questions !== false;
        const shuffleO = !isOwner && flags.shuffle_options !== false;

        await client.query("BEGIN");

        const attemptId = await getOrRestartAttempt(client, quizId, userId);

        // Save every answer submitted from the frontend
        for (const [questionId, selectedOption] of Object.entries(answers)) {
            const questionResult = await client.query(`
                SELECT correct_option_index, options FROM quiz_questions
                WHERE id = $1 AND quiz_id = $2
            `, [questionId, quizId]);

            if (questionResult.rows.length === 0) continue; // ignore stray/unknown question ids

            const row = questionResult.rows[0];

            /*
             * The student picked a position in *their* shuffled list, so it has
             * to be translated back before it means anything. Rebuilding the
             * same permutation from the same seed is what makes this possible
             * without having stored the order at serve time.
             *
             * Answers are persisted in original order so the stored data stays
             * canonical — a later change to the shuffle cannot retroactively
             * alter what an already-graded student appears to have chosen.
             */
            const opts = Array.isArray(row.options) ? row.options : [];
            const optionOrder = shuffleO
                ? seededPermutation(opts.length, optionOrderSeed(quizId, userId, questionId))
                : opts.map((_, i) => i);

            const displayIndex = Number(selectedOption);
            const originalIndex =
                Number.isInteger(displayIndex) && displayIndex >= 0 && displayIndex < optionOrder.length
                    ? optionOrder[displayIndex]
                    : null;

            // An out-of-range index means a stale client or a tampered payload;
            // record it as wrong rather than crashing or crediting it.
            const isCorrect = originalIndex !== null && originalIndex === row.correct_option_index;

            await client.query(`
                INSERT INTO quiz_answers (attempt_id, question_id, selected_option, is_correct, answered_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (attempt_id, question_id)
                DO UPDATE SET
                    selected_option = EXCLUDED.selected_option,
                    is_correct = EXCLUDED.is_correct,
                    answered_at = NOW()
            `, [attemptId, questionId, originalIndex, isCorrect]);
        }

        // Recompute totals from what's actually saved for this attempt
        const totalsResult = await client.query(`
            SELECT
                (SELECT COUNT(*) FROM quiz_answers WHERE attempt_id = $1 AND is_correct = true) AS correct_answers,
                (SELECT COUNT(*) FROM quiz_answers WHERE attempt_id = $1) AS answered_count,
                (SELECT COUNT(*) FROM quiz_questions WHERE quiz_id = $2) AS total_questions
        `, [attemptId, quizId]);

        const correctAnswers = Number(totalsResult.rows[0].correct_answers);
        const answeredCount = Number(totalsResult.rows[0].answered_count);
        const totalQuestions = Number(totalsResult.rows[0].total_questions);
        const score = totalQuestions > 0 ? Math.round((correctAnswers / totalQuestions) * 100) : 0;

        await client.query(`
            UPDATE quiz_attempts
            SET
                status = 'completed',
                correct_answers = $1,
                total_questions = $2,
                score = $3,
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = $4
        `, [correctAnswers, totalQuestions, score, attemptId]);

        await client.query("COMMIT");

        // ================================================================
        // PER-QUESTION REVIEW
        // ================================================================
        // Only assembled after the attempt is committed. correct_option_index
        // is deliberately withheld from students by GET /:quizId — sending it
        // with the questions would hand them the answer key before they
        // answer. Once the attempt is finalised there is nothing left to leak.
        //
        // LEFT JOIN so unanswered questions still appear, with a null
        // selected_option rather than being silently dropped from the review.
        const reviewResult = await client.query(`
            SELECT
                q.id            AS question_id,
                q.question_text,
                q.options,
                q.correct_option_index,
                q.image_url,
                a.selected_option,
                COALESCE(a.is_correct, false) AS is_correct
            FROM quiz_questions q
            LEFT JOIN quiz_answers a
                   ON a.question_id = q.id AND a.attempt_id = $1
            WHERE q.quiz_id = $2
            ORDER BY q.created_at ASC
        `, [attemptId, quizId]);

        /*
         * Re-apply the student's own shuffle to the review.
         *
         * Storage is canonical (original order), so a review rendered straight
         * from the database would list the options in an order the student
         * never saw — "you picked the third one" pointing at something that had
         * been second on their screen. Mapping both indices back into display
         * space keeps the review consistent with the quiz they actually sat.
         */
        const reviewRows = reviewResult.rows;
        const reviewQuestionOrder = shuffleQ
            ? seededPermutation(reviewRows.length, questionOrderSeed(quizId, userId))
            : reviewRows.map((_, i) => i);

        const results = reviewQuestionOrder.map((pos) => {
            const r = reviewRows[pos];
            const opts = Array.isArray(r.options) ? r.options : [];

            const optionOrder = shuffleO
                ? seededPermutation(opts.length, optionOrderSeed(quizId, userId, r.question_id))
                : opts.map((_, i) => i);
            const toDisplay = invertPermutation(optionOrder);

            return {
                questionId: r.question_id,
                questionText: r.question_text,
                options: optionOrder.map((i) => opts[i]),
                imageUrl: r.image_url,
                selectedOption:
                    r.selected_option === null || r.selected_option === undefined
                        ? null
                        : toDisplay[r.selected_option] ?? null,
                correctOption: toDisplay[r.correct_option_index] ?? r.correct_option_index,
                isCorrect: r.is_correct,
            };
        });

        const unanswered = results.filter((r) => r.selectedOption === null).length;

        // ================================================================
        // STATS (computed after commit, so this attempt is included below)
        // ================================================================

        // Time taken for this attempt.
        // Prefer the client-measured open->submit duration (accurate);
        // fall back to the DB timestamp diff only if the client didn't
        // send a valid number (e.g. older app build).
        let timeTakenSeconds;
        const parsedClientTime = Number(clientTimeTakenSeconds);
        if (Number.isFinite(parsedClientTime) && parsedClientTime >= 0) {
            timeTakenSeconds = Math.round(parsedClientTime);
        } else {
            const timingResult = await pool.query(`
                SELECT started_at, completed_at FROM quiz_attempts WHERE id = $1
            `, [attemptId]);
            const { started_at, completed_at } = timingResult.rows[0];
            timeTakenSeconds = Math.max(
                0,
                Math.round((new Date(completed_at).getTime() - new Date(started_at).getTime()) / 1000)
            );
        }

        // Accuracy -- of the questions actually answered, how many were right
        const accuracy = answeredCount > 0 ? Math.round((correctAnswers / answeredCount) * 100) : 0;

        // Rank + Percentile -- among enrolled students of this course who
        // have completed THIS quiz, ranked by score.
        const peerScoresResult = await pool.query(`
            SELECT qa.score
            FROM quiz_attempts qa
            JOIN enrollments e ON e.user_id = qa.user_id AND e.course_id = $1 AND e.status = 'active'
            WHERE qa.quiz_id = $2 AND qa.status = 'completed'
        `, [courseId, quizId]);

        const peerScores = peerScoresResult.rows.map(r => Number(r.score));
        const totalAttempts = peerScores.length;
        const scoredHigher = peerScores.filter(s => s > score).length;
        const scoredLower = peerScores.filter(s => s < score).length;
        const rank = scoredHigher + 1;
        const percentile = totalAttempts > 1
            ? Math.round((scoredLower / (totalAttempts - 1)) * 100)
            : 100;

        // Attempt % -- of all quizzes in this course, how many has this
        // student completed (including this one, just committed).
        const quizCountsResult = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM quizzes q JOIN modules m ON q.module_id = m.id WHERE m.course_id = $1)::int AS total_quizzes,
                (SELECT COUNT(DISTINCT qa.quiz_id) FROM quiz_attempts qa
                    JOIN quizzes q ON qa.quiz_id = q.id
                    JOIN modules m ON q.module_id = m.id
                 WHERE m.course_id = $1 AND qa.user_id = $2 AND qa.status = 'completed')::int AS attempted_quizzes
        `, [courseId, userId]);

        const { total_quizzes: totalQuizzes, attempted_quizzes: attemptedQuizzes } = quizCountsResult.rows[0];
        const attemptPercent = totalQuizzes > 0 ? Math.round((attemptedQuizzes / totalQuizzes) * 100) : 0;

        // Tell the teacher a submission landed. Addressed to the course owner
        // rather than every educator: a large platform would otherwise notify
        // teachers about students they do not teach.
        await notifyCourseOwner(courseId, {
            type: "submission",
            title: `${req.user.name || "A student"} completed a quiz`,
            body: `Scored ${score}% on ${totalQuestions} question${totalQuestions === 1 ? "" : "s"}`,
            actorId: req.user.id,
            link: `/analytics`,
        });

        res.json({
            success: true,
            attemptId,
            total: totalQuestions,
            correct: correctAnswers,
            incorrect: totalQuestions - correctAnswers - unanswered,
            unanswered,
            score,
            results,
            stats: {
                rank,
                totalAttempts,
                percentile,
                accuracy,
                attemptPercent,
                attemptedQuizzes,
                totalQuizzes,
                timeTakenSeconds
            }
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Quiz submit error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// GET QUIZ ATTEMPT HISTORY
// ============================================================
router.get("/:quizId/attempts", authMiddleware, async (req, res) => {
    try {
        const { quizId } = req.params;
        const userId = req.user.id;

        const quizCheck = await pool.query(`
            SELECT c.educator_id
            FROM quizzes q
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE q.id = $1
        `, [quizId]);

        const isOwner = quizCheck.rows.length > 0 && quizCheck.rows[0].educator_id === userId;

        if (!isOwner) {
            const result = await pool.query(`
                SELECT 
                    id, score, total_questions, correct_answers,
                    started_at, completed_at, status
                FROM quiz_attempts
                WHERE quiz_id = $1 AND user_id = $2
                ORDER BY started_at DESC
            `, [quizId, userId]);

            return res.json({
                success: true,
                attempts: result.rows,
                isOwner: false
            });
        }

        const result = await pool.query(`
            SELECT 
                qa.*,
                u.name as student_name,
                u.email as student_email
            FROM quiz_attempts qa
            JOIN users u ON qa.user_id = u.id
            WHERE qa.quiz_id = $1
            ORDER BY qa.started_at DESC
        `, [quizId]);

        res.json({
            success: true,
            attempts: result.rows,
            isOwner: true
        });

    } catch (err) {
        console.error("Get quiz attempts error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET QUIZ ATTEMPT DETAILS
// ============================================================
router.get("/attempt/:attemptId", authMiddleware, async (req, res) => {
    try {
        const { attemptId } = req.params;
        const userId = req.user.id;

        const attemptResult = await pool.query(`
            SELECT qa.*, q.title as quiz_title, q.id as quiz_id
            FROM quiz_attempts qa
            JOIN quizzes q ON qa.quiz_id = q.id
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE qa.id = $1
        `, [attemptId]);

        if (attemptResult.rows.length === 0) {
            return res.status(404).json({ error: "Attempt not found" });
        }

        const attempt = attemptResult.rows[0];
        const isOwner = attempt.user_id === userId || attempt.educator_id === userId;

        if (!isOwner && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Access denied" });
        }

        const answersResult = await pool.query(`
            SELECT 
                qa.*,
                qq.question_text,
                qq.options,
                qq.correct_option_index,
                qq.image_url
            FROM quiz_answers qa
            JOIN quiz_questions qq ON qa.question_id = qq.id
            WHERE qa.attempt_id = $1
            ORDER BY qq.created_at ASC
        `, [attemptId]);

        res.json({
            success: true,
            attempt,
            answers: answersResult.rows
        });

    } catch (err) {
        console.error("Get attempt details error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET QUIZ
// ============================================================
router.get("/:quizId", authMiddleware, async (req, res) => {
    try {
        const { quizId } = req.params;

        const quizResult = await pool.query(`
            SELECT q.*, c.id AS course_id, c.educator_id
            FROM quizzes q
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE q.id = $1
        `, [quizId]);

        if (quizResult.rows.length === 0) {
            return res.status(404).json({ error: "Quiz not found" });
        }

        const quiz = quizResult.rows[0];

        const access = await checkQuizAccess(pool, quizId, req.user);
        if (!access.ok) {
            if (access.debug) console.warn("[quiz] access denied:", access.error, access.debug);
            return res.status(access.status).json({ error: access.error });
        }
        const isOwner = access.isOwner;

        const questionsResult = await pool.query(`
            SELECT id, question_text, options, correct_option_index, image_url
            FROM quiz_questions WHERE quiz_id = $1 ORDER BY created_at ASC
        `, [quizId]);

        /*
         * Students get their own question and option order; the author does
         * not. Shuffling the owner's view would make the quiz they wrote hard
         * to proof-read against the source document, and they are not the ones
         * copying from a neighbour.
         *
         * Derived from (quizId, userId) rather than randomised per request, so
         * a refresh mid-quiz does not reorder the options under the student and
         * turn an already-selected answer into a different one.
         */
        const rows = questionsResult.rows;

        // The author always sees the order they wrote, whatever the flags say.
        const shuffleQ = !isOwner && quiz.shuffle_questions !== false;
        const shuffleO = !isOwner && quiz.shuffle_options !== false;

        const questionOrder = shuffleQ
            ? seededPermutation(rows.length, questionOrderSeed(quizId, req.user.id))
            : rows.map((_, i) => i);

        const questions = questionOrder.map((originalPos) => {
            const q = rows[originalPos];
            const opts = Array.isArray(q.options) ? q.options : [];

            const optionOrder = shuffleO
                ? seededPermutation(opts.length, optionOrderSeed(quizId, req.user.id, q.id))
                : opts.map((_, i) => i);

            return {
                id: q.id,
                question_text: q.question_text,
                options: optionOrder.map((i) => opts[i]),
                image_url: q.image_url,
                // Withheld from students entirely. Note it would also be the
                // *original* index and therefore wrong against the shuffled
                // options — another reason not to leak it.
                ...(isOwner ? { correct_option_index: q.correct_option_index } : {})
            };
        });

        let attempt = null;
        if (!isOwner) {
            const attemptResult = await pool.query(`
                SELECT id, started_at, status
                FROM quiz_attempts
                WHERE quiz_id = $1 AND user_id = $2 AND status = 'in_progress'
                ORDER BY started_at DESC LIMIT 1
            `, [quizId, req.user.id]);

            if (attemptResult.rows.length > 0) {
                attempt = attemptResult.rows[0];
            }
        }

        res.json({
            success: true,
            quiz: {
                id: quiz.id,
                title: quiz.title,
                description: quiz.description,
                module_id: quiz.module_id,
                folder_id: quiz.folder_id,
                shuffle_questions: quiz.shuffle_questions,
                shuffle_options: quiz.shuffle_options,
                // Without this the countdown has nothing to count — the field
                // was being dropped here, so every quiz looked untimed.
                time_limit: quiz.time_limit
            },
            questions,
            isOwner,
            attempt
        });

    } catch (err) {
        console.error("Quiz fetch error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET QUIZZES FOR MODULE
// ============================================================
router.get("/module/:moduleId", authMiddleware, async (req, res) => {
    try {
        const { moduleId } = req.params;
        const userId = req.user.id;

        // 🌟 PROGRESS TRACKING: left-join the current user's own completed
        // attempt so the frontend can show a "Completed" badge + score.
        const result = await pool.query(`
            SELECT q.id, q.title, q.description, q.created_at, q.folder_id,
                   q.time_limit,
                   COALESCE(q.priority, 0) AS priority,
                   COUNT(DISTINCT qq.id)::int AS question_count,
                   qa.score AS user_score,
                   (qa.status = 'completed') AS is_completed
            FROM quizzes q
            LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
            LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.user_id = $2 AND qa.status = 'completed'
            WHERE q.module_id = $1
            GROUP BY q.id, qa.score, qa.status
            ORDER BY COALESCE(q.priority, 0) ASC, q.created_at ASC
        `, [moduleId, userId]);

        res.json({ success: true, quizzes: result.rows });
    } catch (err) {
        console.error("Quiz list error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET QUIZ SCORE SUMMARY
// ============================================================
router.get("/summary/:quizId", authMiddleware, async (req, res) => {
    try {
        const { quizId } = req.params;
        const userId = req.user.id;

        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_attempts,
                AVG(score) as avg_score,
                MAX(score) as highest_score,
                MIN(score) as lowest_score,
                (
                    SELECT score FROM quiz_attempts 
                    WHERE quiz_id = $1 AND user_id = $2
                    ORDER BY completed_at DESC LIMIT 1
                ) as user_last_score,
                (
                    SELECT id FROM quiz_attempts 
                    WHERE quiz_id = $1 AND user_id = $2 AND status = 'completed'
                    ORDER BY completed_at DESC LIMIT 1
                ) as user_last_attempt_id
            FROM quiz_attempts
            WHERE quiz_id = $1 AND status = 'completed'
        `, [quizId, userId]);

        res.json({
            success: true,
            summary: result.rows[0] || { total_attempts: 0, avg_score: 0 }
        });

    } catch (err) {
        console.error("Quiz summary error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DELETE QUIZ
// ============================================================
/**
 * PUT /api/quiz/:quizId — update a quiz and its questions.
 *
 * The whole question set is replaced rather than diffed. Matching submitted
 * questions to stored ones would need stable ids the builder does not carry,
 * and a wrong match would silently move a correct answer onto the wrong
 * question — worse than the cost of rewriting a handful of rows.
 *
 * Consequence worth knowing: existing attempts reference question ids that
 * this deletes, so past answers are removed with them. The UI warns when the
 * quiz already has attempts.
 */
router.put("/:quizId", authMiddleware, async (req, res) => {
    const { quizId } = req.params;
    const {
        title, description, questions, time_limit,
        shuffle_questions, shuffle_options,
    } = req.body;

    if (!title || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "title and at least one question are required" });
    }

    let minutes = null;
    if (time_limit !== undefined && time_limit !== null && time_limit !== "") {
        minutes = Number(time_limit);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
            return res.status(400).json({
                error: "Time limit must be a whole number of minutes between 1 and 480, or left empty for no limit.",
            });
        }
    }

    for (const q of questions) {
        if (!q.question_text || !Array.isArray(q.options) || q.options.length < 2) {
            return res.status(400).json({ error: "Each question needs text and at least 2 options" });
        }
        if (
            typeof q.correct_option_index !== "number" ||
            q.correct_option_index < 0 ||
            q.correct_option_index >= q.options.length
        ) {
            return res.status(400).json({ error: "Each question needs a valid correct_option_index" });
        }
    }

    const client = await pool.connect();
    try {
        const owner = await client.query(`
            SELECT c.educator_id
            FROM quizzes q
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE q.id = $1
        `, [quizId]);

        if (owner.rows.length === 0) return res.status(404).json({ error: "Quiz not found" });
        if (owner.rows[0].educator_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only the course creator can edit this quiz" });
        }

        await client.query("BEGIN");

        await client.query(`
            UPDATE quizzes
            SET title = $1,
                description = $2,
                time_limit = $3,
                shuffle_questions = $4,
                shuffle_options = $5,
                updated_at = NOW()
            WHERE id = $6
        `, [
            title,
            description || "",
            minutes,
            shuffle_questions !== false,
            shuffle_options !== false,
            quizId,
        ]);

        // quiz_answers references quiz_questions, so this cascades to past
        // answers. Attempts keep their recorded score; only the per-question
        // breakdown is lost.
        await client.query(`DELETE FROM quiz_questions WHERE quiz_id = $1`, [quizId]);

        for (const q of questions) {
            await client.query(`
                INSERT INTO quiz_questions (quiz_id, question_text, options, correct_option_index, image_url)
                VALUES ($1, $2, $3, $4, $5)
            `, [quizId, q.question_text, JSON.stringify(q.options), q.correct_option_index, q.image_url || null]);
        }

        await client.query("COMMIT");
        res.json({ success: true, message: "Quiz updated" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Quiz update error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.delete("/:quizId", authMiddleware, async (req, res) => {
    try {
        const { quizId } = req.params;

        const quizCheck = await pool.query(`
            SELECT c.educator_id
            FROM quizzes q
            JOIN modules m ON q.module_id = m.id
            JOIN courses c ON m.course_id = c.id
            WHERE q.id = $1
        `, [quizId]);

        if (quizCheck.rows.length === 0) {
            return res.status(404).json({ error: "Quiz not found" });
        }
        if (!canManage(quizCheck.rows[0].educator_id, req.user)) {
            return res.status(403).json({ error: "Only the course creator or an admin can delete this quiz" });
        }

        await pool.query(`DELETE FROM quizzes WHERE id = $1`, [quizId]);
        res.json({ success: true, message: "Quiz deleted" });
    } catch (err) {
        console.error("Quiz delete error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;