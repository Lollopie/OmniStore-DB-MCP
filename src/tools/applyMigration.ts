import z from "zod";
import * as crypto from 'crypto';
import { getMigrationDataSource } from "../../migratorDS";
import { assertNotApplied, expired, expiresAt, Plan, planHash, plans, PlanStatus, recordMigration, UserFacingError } from "./planMigration";
import { APPROVAL_ORIGIN } from "../approval/constants";
import { isTotpConfigured } from "../approval/totp";

// Serializes migrations, also against other processes that use the same key
const MIGRATION_LOCK_KEY = 727274;

export const applyMigrationInputSchema = z.object({
    planId: z.string().describe('planId returned by plan_migration'),
});

export const migrationStatusOutputSchema = z.object({
    planId: z.string(),
    status: z.enum(PlanStatus),
    expiresAt: z.string(),
    approvalUrl: z.string().optional().describe('Give this URL to the human. They approve on that page with an authenticator code.'),
    error: z.string().optional(),
});

function result(structuredContent: z.infer<typeof migrationStatusOutputSchema>) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
    };
}

function getPlan(planId: string): Plan {
    const plan = plans.get(planId);
    if (!plan) throw new UserFacingError('Unknown plan. Plans are kept in memory, so create it again with plan_migration.');
    if ((plan.status === PlanStatus.planned || plan.status === PlanStatus.pending_approval) && expired(plan)) {
        plan.status = PlanStatus.expired;
        plan.approvalToken = undefined;
    }
    return plan;
}

// Doesn't run anything. Opens the plan for approval and returns the page where a human approves it.
export async function applyMigration(planId: string) {
    const plan = getPlan(planId);
    if (plan.status !== PlanStatus.planned) {
        throw new UserFacingError(`Plan is ${plan.status}. Only a freshly planned migration can be submitted for approval.`);
    }
    if (!isTotpConfigured()) throw new UserFacingError('Approval isn\'t set up. A human has to run `npm run approval:setup` first.');

    // Early feedback only. executeMigration checks again under the lock.
    const qr = (await getMigrationDataSource()).createQueryRunner();
    try {
        await assertNotApplied(qr, plan.name, plan.timestamp);
    } finally {
        await qr.release();
    }

    plan.approvalToken = crypto.randomBytes(32).toString('base64url');
    plan.status = PlanStatus.pending_approval;
    return result({
        planId,
        status: plan.status,
        expiresAt: expiresAt(plan),
        approvalUrl: `${APPROVAL_ORIGIN}/approve/${plan.approvalToken}`,
    });
}

export function getMigrationStatus(planId: string) {
    const plan = getPlan(planId);
    return result({ planId, status: plan.status, expiresAt: expiresAt(plan), error: plan.error });
}

// Only called by the approval page, after a valid TOTP code. submittedPlanId is the plan ID the page showed.
export async function executeMigration(plan: Plan, submittedPlanId: string) {
    plan.status = PlanStatus.applying;
    plan.approvalToken = undefined;
    try {
        const hash = planHash(plan.name, plan.timestamp, plan.sql);
        if (hash !== plan.id || hash !== submittedPlanId) {
            throw new Error('The plan changed after it was shown for approval. Nothing was run.');
        }
        const qr = (await getMigrationDataSource()).createQueryRunner();
        try {
            await qr.connect();
            await qr.startTransaction();
            await qr.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
            await qr.query("SET LOCAL statement_timeout = '60s'");
            await qr.query("SET LOCAL lock_timeout = '10s'");
            await assertNotApplied(qr, plan.name, plan.timestamp);
            await qr.query(plan.sql);
            await recordMigration(qr, plan.name, plan.timestamp);
            await qr.commitTransaction();
        } catch (e) {
            await qr.rollbackTransaction().catch(() => {});
            throw e;
        } finally {
            await qr.release();
        }
        plan.status = PlanStatus.applied;
    } catch (e) {
        plan.status = PlanStatus.failed;
        plan.error = e instanceof Error ? e.message : String(e);
    }
}
