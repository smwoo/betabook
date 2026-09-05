"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
import { useState, useTransition } from "react";

import { updateDisplayName } from "@/actions";
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/display-name";

export function DisplayNameForm({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // Compared trimmed so whitespace-only edits don't arm the save button;
  // `saved` state stands in for a page reload (the action's refresh()
  // re-renders the server components around this form).
  const unchanged = name.trim() === initialName;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const formData = new FormData();
    formData.set("name", name.trim());

    startTransition(async () => {
      const result = await updateDisplayName(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <TextField value={name} onChange={setName} isRequired maxLength={MAX_DISPLAY_NAME_LENGTH}>
        <Label>Display name</Label>
        <div className="flex items-start gap-2">
          <Input placeholder="Your display name" />
          <Button type="submit" isDisabled={pending || unchanged || !name.trim()}>
            Save
          </Button>
        </div>
      </TextField>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          Display name updated.
        </p>
      )}
    </form>
  );
}
