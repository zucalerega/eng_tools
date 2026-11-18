import type { Component, Milestone, ProgramDetail, Review } from "./api";
import { statusAt } from "./vehicle";

// A program's design reviews, as the bill, a component's panel, and a review's page show them: each held at one of the
// program's review milestones for several of its components at once (Review.tsx is its page).

/** Where a review's page is. */
export const reviewPath = (review: Review) => `/buildflow/programs/${review.program_id}/reviews/${review.id}`;

/** The components a review covers that are on its program now, in the program's order. */
export const coveredBy = (review: Review, program: ProgramDetail): Component[] =>
    program.components.filter((c) => review.component_ids.includes(c.id));

/** The reviews held for a component at a milestone. */
export const reviewsOf = (program: ProgramDetail, component: Component, milestone: Milestone): Review[] =>
    program.reviews.filter((r) => r.milestone_id === milestone.id && r.component_ids.includes(component.id));

/** Whether a component's through a milestone: passed it, or not needing it. A review leaves these as they are. */
export function through(component: Component, milestone: Milestone): boolean {
    const status = statusAt(component, milestone);
    return status === "done" || status === "skipped";
}
