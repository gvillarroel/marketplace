/** Process-local bridge between OpenCode server reservations and the TUI team view. */
import { resolve } from "node:path";
const maximumOpenCodeAgentActivitiesPerProject = 32;
const activities = new Map();
function projectKey(project) {
    const absolute = resolve(project);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function activityKey(project, agent) {
    return `${projectKey(project)}\u0000${agent}`;
}
/** Atomically claims one player so plugin instances cannot overlap during host-session startup or cleanup. */
export function claimOpenCodeAgentActivity(project, agent, kind, now = Date.now()) {
    const normalizedProject = projectKey(project);
    const key = activityKey(normalizedProject, agent);
    if (activities.has(key))
        throw new Error(`Agent Harbor player ${agent} is busy in another direct or delegated run`);
    let projectCount = 0;
    for (const activity of activities.values()) {
        if (activity.project === normalizedProject)
            projectCount += 1;
    }
    if (projectCount >= maximumOpenCodeAgentActivitiesPerProject) {
        throw new Error(`Agent Harbor allows at most ${maximumOpenCodeAgentActivitiesPerProject} active runs per project; wait for work to finish or use /team stop`);
    }
    const token = {};
    const stored = {
        token, project: normalizedProject, agent, kind, phase: "starting", startedAt: Math.max(0, now),
    };
    activities.set(key, stored);
    const snapshot = () => ({
        agent: stored.agent,
        kind: stored.kind,
        phase: stored.phase,
        startedAt: stored.startedAt,
    });
    return {
        get snapshot() { return snapshot(); },
        setPhase(phase) {
            if (activities.get(key)?.token === token)
                stored.phase = phase;
        },
        release() {
            if (activities.get(key)?.token === token)
                activities.delete(key);
        },
    };
}
/** Returns defensive, bounded public activity facts without session IDs, tasks, or provider metadata. */
export function readOpenCodeAgentActivities(project) {
    const normalizedProject = projectKey(project);
    return [...activities.values()]
        .filter((activity) => activity.project === normalizedProject)
        .slice(0, maximumOpenCodeAgentActivitiesPerProject)
        .map(({ agent, kind, phase, startedAt }) => ({ agent, kind, phase, startedAt }));
}
