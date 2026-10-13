// /incidents: the queue on the left is the list; this pane waits for a selection.
export default function IncidentsPage() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-16 text-center">
      <h1 className="text-xl font-semibold">Pick an incident from the queue</h1>
      <p className="mt-2 text-sm text-sub">Unresolved incidents are on the left, most urgent first. Resolved ones are under the Resolved tab.</p>
    </div>
  );
}
