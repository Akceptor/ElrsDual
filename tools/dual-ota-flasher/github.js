const API = "https://api.github.com";

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28" };
}

export async function dispatchBuild({ repo, token, workflow, ref, inputs, fetchFn = fetch }) {
  const url = `${API}/repos/${repo.owner}/${repo.repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetchFn(url, { method: "POST", headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref, inputs }) });
  if (!res.ok) throw new Error(`dispatch failed: HTTP ${res.status}`);
}

// Poll the workflow's runs and return the one whose name/display embeds run_tag.
export async function findRunByTag({ repo, token, workflow, runTag, fetchFn = fetch }) {
  const url = `${API}/repos/${repo.owner}/${repo.repo}/actions/workflows/${workflow}/runs?per_page=20&event=workflow_dispatch`;
  const res = await fetchFn(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`list runs failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.workflow_runs || []).find((r) => (r.name || "").includes(runTag) || (r.display_title || "").includes(runTag)) || null;
}

export async function fetchArtifactBin({ repo, token, branch, path, fetchFn = fetch }) {
  const cUrl = `${API}/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${branch}`;
  const c = await fetchFn(cUrl, { headers: headers(token) });
  if (!c.ok) throw new Error(`artifact not found (${path}@${branch}): HTTP ${c.status}`);
  const { sha } = await c.json();
  const bUrl = `${API}/repos/${repo.owner}/${repo.repo}/git/blobs/${sha}`;
  const b = await fetchFn(bUrl, { headers: headers(token) });
  if (!b.ok) throw new Error(`blob fetch failed: HTTP ${b.status}`);
  const { content } = await b.json();
  const bin = atob(content.replace(/\n/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
