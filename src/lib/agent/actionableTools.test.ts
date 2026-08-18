import { describe, it, expect } from "vitest";
import {
  createActionableTool,
  listActionablesTool,
  updateActionableTool,
  deleteActionableTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
} from "./tools";

// The duplicate-actionable bug was not a duplication fault — it was a MISSING
// VERB. create_actionable was the agent's only actionable tool, so asked to
// retime one it created a second, then a third. Events already had full
// create/update/delete; actionables must keep parity or the same class of bug
// returns the moment someone asks the agent to change one.
describe("actionable tools have create/update/delete parity with events", () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

  it("exposes list, update and delete alongside create", () => {
    expect(
      names([
        createActionableTool(),
        listActionablesTool(),
        updateActionableTool(),
        deleteActionableTool(),
      ])
    ).toEqual([
      "create_actionable",
      "delete_actionable",
      "list_actionables",
      "update_actionable",
    ]);
  });

  it("mirrors the verbs events already had", () => {
    const eventVerbs = names([createEventTool(), updateEventTool(), deleteEventTool()])
      .map((n) => n.replace("_event", ""))
      .sort();
    const actionableVerbs = names([
      createActionableTool(),
      updateActionableTool(),
      deleteActionableTool(),
    ])
      .map((n) => n.replace("_actionable", ""))
      .sort();
    expect(actionableVerbs).toEqual(eventVerbs);
  });

  it("update requires an id, so it can never be used to create a second item", () => {
    // betaTool normalises the schema onto `input_schema`.
    const tool = updateActionableTool() as unknown as { input_schema: { required?: string[] } };
    expect(tool.input_schema.required).toContain("id");
  });

  it("tells the agent to update rather than create a duplicate", () => {
    // `description` is present on the built tool but not on the union type.
    const desc = (t: unknown) => (t as { description: string }).description;
    expect(desc(updateActionableTool())).toMatch(/never create a second/i);
    expect(desc(listActionablesTool())).toMatch(/before creating/i);
  });
});
