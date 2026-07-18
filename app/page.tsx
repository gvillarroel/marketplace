"use client";

import { useMemo, useState } from "react";

const plugins = [
  { name: "Agent Foundry", id: "agent-foundry", version: "0.1.0", accent: "violet", summary: "Build a workforce inside any repository.", description: "Permanent project agents and disposable contractors, powered by the Copilot SDK and skills from any GitHub repository.", features: ["4 slash commands", "3 agent tools", "Copilot SDK", "Remote skills"], install: "copilot plugin install agent-foundry@agent-harbor", icon: "AF" },
  { name: "Repo Cartographer", id: "repo-cartographer", version: "0.1.0", accent: "mint", summary: "See the shape of a codebase, fast.", description: "A focused repository mapper plus a zx automation skill mixed in from gvillarroel/zx-harness.", features: ["1 custom agent", "2 skills", "Cross-repo source", "No extension"], install: "copilot plugin install repo-cartographer@agent-harbor", icon: "RC" },
];

type Agent = { name: string; role: string; type: "Permanent" | "Contractor"; skills: string[]; tools: string[] };

export default function Home() {
  const [tab, setTab] = useState<"market" | "studio">("market");
  const [copied, setCopied] = useState("");
  const [installed, setInstalled] = useState<string[]>([]);
  const [agents, setAgents] = useState<Agent[]>([{ name: "release-scout", role: "Reviews release readiness", type: "Permanent", skills: ["repository-map"], tools: ["read", "shell"] }]);
  const [name, setName] = useState("typescript-builder");
  const [contractor, setContractor] = useState(true);
  const command = "copilot plugin marketplace add gvillarroel/marketplace";
  const status = useMemo(() => `${installed.length}/2 plugins installed · ${agents.length} agent${agents.length === 1 ? "" : "s"}`, [installed, agents]);
  const copy = async (text: string, id: string) => { await navigator.clipboard?.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); };
  const addAgent = () => {
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!clean) return;
    setAgents((items) => [...items, { name: clean, role: contractor ? "One focused task, then forgotten" : "Reusable project specialist", type: contractor ? "Contractor" : "Permanent", skills: ["agent-blueprints", "zx-example-author"], tools: ["read", "write"] }]);
    setName("");
  };

  return <main>
    <header className="nav shell">
      <button className="brand" onClick={() => setTab("market")}><span className="brandmark">A/</span><span>Agent Harbor</span><em>POC</em></button>
      <nav aria-label="Primary navigation">
        <button className={tab === "market" ? "active" : ""} onClick={() => setTab("market")}>Marketplace</button>
        <button className={tab === "studio" ? "active" : ""} onClick={() => setTab("studio")}>Agent Studio</button>
        <a href="https://github.com/gvillarroel/marketplace">GitHub ↗</a>
      </nav>
    </header>

    {tab === "market" ? <>
      <section className="hero shell">
        <div className="eyebrow"><i /> Built for GitHub Copilot CLI</div>
        <h1>Give Copilot a<br/><span>specialist bench.</span></h1>
        <p>Install agents, skills, and live TypeScript-powered extensions from one composable marketplace.</p>
        <div className="terminal"><span>$</span><code>{command}</code><button onClick={() => copy(command, "market")}>{copied === "market" ? "Copied" : "Copy"}</button></div>
        <div className="signal"><span>● Copilot CLI 1.0.70 verified</span><span>Two installable plugins</span><span>Local + remote skills</span></div>
      </section>

      <section className="catalog shell">
        <div className="sectionhead"><div><span className="kicker">01 / CATALOG</span><h2>Featured plugins</h2></div><p>Small, inspectable capability packs.<br/>No black boxes.</p></div>
        <div className="plugin-grid">{plugins.map((plugin, index) => <article className={`plugin ${plugin.accent}`} key={plugin.id}>
          <div className="plugin-top"><span className="plugin-icon">{plugin.icon}</span><span className="version">v{plugin.version}</span></div>
          <span className="index">0{index + 1}</span><h3>{plugin.name}</h3><strong>{plugin.summary}</strong><p>{plugin.description}</p>
          <div className="tags">{plugin.features.map((feature) => <span key={feature}>{feature}</span>)}</div>
          <div className="install-row"><code>{plugin.install}</code><button onClick={() => copy(plugin.install, plugin.id)}>{copied === plugin.id ? "✓" : "⧉"}</button></div>
          <button className={`install ${installed.includes(plugin.id) ? "done" : ""}`} onClick={() => setInstalled((items) => items.includes(plugin.id) ? items.filter((x) => x !== plugin.id) : [...items, plugin.id])}>{installed.includes(plugin.id) ? "Installed locally ✓" : "Stage for install →"}</button>
        </article>)}</div>
      </section>

      <section className="flow shell">
        <div><span className="kicker">02 / HOW IT COMPOSES</span><h2>Skills travel.<br/>Agents stay focused.</h2></div>
        <div className="pipeline"><div><b>01</b><strong>Source</strong><span>This repo or any GitHub repo</span></div><i>→</i><div><b>02</b><strong>Inject</strong><span>Prompt + tools + named skills</span></div><i>→</i><div><b>03</b><strong>Run</strong><span>Permanent or disposable SDK session</span></div></div>
      </section>
    </> : <section className="studio shell">
      <div className="studio-head"><div><span className="kicker">AGENT STUDIO / LIVE MODEL</span><h1>Build your bench.</h1><p>Configure a profile once—or contract it for exactly one task.</p></div><div className="status"><i />{status}</div></div>
      <div className="studio-grid">
        <div className="builder">
          <h2>New virtual agent</h2><label>Agent ID<input value={name} onChange={(e) => setName(e.target.value)} placeholder="typescript-builder" /></label>
          <label>Lifecycle</label><div className="toggle"><button className={!contractor ? "selected" : ""} onClick={() => setContractor(false)}>Permanent<span>Writes .github/agents</span></button><button className={contractor ? "selected" : ""} onClick={() => setContractor(true)}>Contractor<span>Destroyed after task</span></button></div>
          <label>Skills</label><div className="skill-pills"><span>agent-blueprints <b>local</b></span><span>zx-example-author <b>gvillarroel/zx-harness</b></span></div>
          <label>Allowed tools</label><div className="checks"><span>✓ read</span><span>✓ write</span><span>○ shell</span><span>○ github</span></div>
          <button className="create" onClick={addAgent}>{contractor ? "Contract agent" : "Hire permanently"} →</button>
        </div>
        <div className="roster"><div className="roster-head"><h2>Current roster</h2><code>/agents</code></div>{agents.map((agent, index) => <article key={`${agent.name}-${index}`}><div className="avatar">{agent.name.slice(0, 2).toUpperCase()}</div><div><h3>{agent.name}</h3><p>{agent.role}</p><span className={agent.type === "Contractor" ? "temporary" : "permanent"}>{agent.type}</span>{agent.skills.map((skill) => <small key={skill}>{skill}</small>)}</div><button aria-label={`Remove ${agent.name}`} onClick={() => setAgents((items) => items.filter((_, i) => i !== index))}>×</button></article>)}{agents.length === 0 && <div className="empty">Your bench is empty.</div>}</div>
      </div>
      <div className="contract"><code>/contract {'{"name":"reviewer", "prompt":"Review only", "tools":["read"]}'} :: audit src/</code><span>One SDK session · minimal reasoning · no memory · automatic cleanup</span></div>
    </section>}
    <footer className="shell"><span><b>A/</b> Agent Harbor</span><p>Open POC · GitHub Copilot-native manifests</p><span>MIT · 2026</span></footer>
  </main>;
}
