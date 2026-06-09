import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useAppStore } from "../store";
import { runSectionGrade, GRADE_RUBRIC_ID } from "../screens/projects/gradeDispatch";
import { GradeReportPane } from "../screens/projects/GradeReportPane";
import type { GradeResult } from "../screens/projects/grading";

const fakeGrade = (graderId: string, letter: GradeResult["letter"], score: number): GradeResult => ({
  graderId, graderLabel: `${graderId} rubric`, sectionKey: "context", score, letter, dimensions: [], findings: [],
});

describe("sectionGrades store + dispatch (#615)", () => {
  beforeEach(() => useAppStore.setState({ sectionGrades: {} }));

  it("setSectionGrade upserts by graderId (one entry per grader)", () => {
    const s = useAppStore.getState();
    s.setSectionGrade("p", "context", fakeGrade("a", "C", 65));
    s.setSectionGrade("p", "context", fakeGrade("b", "A", 95));
    s.setSectionGrade("p", "context", fakeGrade("a", "B", 80)); // re-grade a
    const grades = useAppStore.getState().sectionGrades["p"]["context"];
    expect(grades).toHaveLength(2);
    expect(grades.find((g) => g.graderId === "a")!.letter).toBe("B");
  });

  it("runSectionGrade grades the content + persists", () => {
    const res = runSectionGrade({ projectKey: "p", sectionKey: "context", content: "TODO" });
    expect(res.graderId).toBe("rubric:context");
    expect(["F", "D"]).toContain(res.letter);
    expect(useAppStore.getState().sectionGrades["p"]["context"][0].graderId).toBe("rubric:context");
  });
});

describe("GradeReportPane (#615 slice b)", () => {
  beforeEach(() => useAppStore.setState({ sectionGrades: {} }));

  it("shows the empty state, then grades on click", () => {
    render(<GradeReportPane projectKey="p" sectionKey="context" sectionContent="TODO" />);
    expect(screen.getByText(/No grade yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Grade this section/i }));
    // a grade now renders (thin content ⇒ low letter)
    expect(useAppStore.getState().sectionGrades["p"]["context"]).toHaveLength(1);
    expect(screen.getByText(/\/100/)).toBeInTheDocument();
  });

  it("renders dimension bars + findings for a stored grade", () => {
    useAppStore.getState().setSectionGrade("p", "context", {
      graderId: "rubric:context", graderLabel: "Context rubric", sectionKey: "context", score: 40, letter: "F",
      dimensions: [{ id: "substance", label: "Substance", score: 40 }],
      findings: [{ severity: "error", message: "Add more detail" }],
    });
    render(<GradeReportPane projectKey="p" sectionKey="context" />);
    expect(screen.getByText("Substance")).toBeInTheDocument();
    expect(screen.getByText("Add more detail")).toBeInTheDocument();
  });

  it("shows a tab per grader when a section has multiple", () => {
    const st = useAppStore.getState();
    st.setSectionGrade("p", "context", fakeGrade("rubric:context", "A", 95));
    st.setSectionGrade("p", "context", { ...fakeGrade("agent-readiness", "C", 65), graderLabel: "Agent readiness" });
    render(<GradeReportPane projectKey="p" sectionKey="context" />);
    // both grader tabs present
    expect(screen.getByRole("button", { name: /Agent readiness/i })).toBeInTheDocument();
  });

  it("is registered as a pipeline screen", () => {
    expect(GRADE_RUBRIC_ID).toBe("grade-rubric");
  });
});
