const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorld } = require("./fake-omnifocus");

const LIST_URL = "https://api.github.com/issues?filter=all&state=open&labels=omnifocus&sort=created&direction=asc&per_page=100";

function issue(fullName, number, title, extra = {}) {
	const [, name] = fullName.split("/");
	return {
		number,
		title,
		html_url: `https://github.com/${fullName}/issues/${number}`,
		state: "open",
		state_reason: null,
		repository: { name, full_name: fullName, html_url: `https://github.com/${fullName}` },
		...extra,
	};
}

function issueUrl(key) {
	const [repo, n] = key.split("#");
	return `https://api.github.com/repos/${repo}/issues/${n}`;
}

// Run the action end to end and return the world.
async function run(world) {
	await world.plugin.action.perform(null, null);
	return world;
}

function tasksIn(world, project) {
	return world.db.tasks.filter(t => t.containingProject === project);
}

test("creates one project per repo with tagged, linked tasks in creation order", async () => {
	const w = await run(createWorld({
		responses: {
			[LIST_URL]: { body: [
				issue("kalafut/scorekeeper", 3, "Fix scoring"),
				issue("kalafut/wwv", 47, "Reduce volume"),
				issue("kalafut/scorekeeper", 9, "Add export"),
			] },
		},
	}));

	assert.deepEqual(w.db.projects.map(p => [p.name, p.note]), [
		["scorekeeper", "https://github.com/kalafut/scorekeeper\n"],
		["wwv", "https://github.com/kalafut/wwv\n"],
	]);
	const sk = tasksIn(w, w.db.projects[0]);
	assert.deepEqual(sk.map(t => t.name), ["Fix scoring", "Add export"]);
	assert.equal(sk[0].note, "https://github.com/kalafut/scorekeeper/issues/3\n");
	assert.deepEqual(sk[0].tags.map(t => t.name), ["GitHub"]);
	assert.equal(w.alerts[0].title, "GitHub sync complete");
	assert.match(w.alerts[0].message, /New projects: kalafut\/scorekeeper, kalafut\/wwv/);
	assert.match(w.alerts[0].message, /3 task\(s\) added/);
});

test("sends the token and skips pull requests; follows pagination", async () => {
	const page2 = "https://api.github.com/issues?page=2";
	const w = await run(createWorld({
		savedToken: "secret",
		responses: {
			[LIST_URL]: {
				body: [issue("a/b", 1, "One"), { ...issue("a/b", 2, "A PR"), pull_request: {} }],
				headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
			},
			[page2]: { body: [issue("a/b", 3, "Three")] },
		},
	}));
	assert.deepEqual(w.db.tasks.map(t => t.name), ["One", "Three"]);
	assert.equal(w.requests[0].headers.Authorization, "Bearer secret");
	assert.equal(w.requests.length, 2);
});

test("a second run changes nothing", async () => {
	const responses = { [LIST_URL]: { body: [issue("a/b", 1, "One")] } };
	const w = createWorld({ responses });
	await run(w);
	await run(w);
	assert.equal(w.db.tasks.length, 1);
	assert.equal(w.db.projects.length, 1);
	assert.equal(w.alerts[1].message, "Everything is up to date.");
});

test("renames active synced tasks but leaves OmniFocus-owned fields and placement alone", async () => {
	const responses = { [LIST_URL]: { body: [issue("a/b", 1, "Old title")] } };
	const w = createWorld({ responses });
	await run(w);

	const task = w.db.tasks[0];
	task.note += "my own notes";
	task.flagged = true;
	const elsewhere = new w.Project("Today");
	task.containingProject = elsewhere; // user moved it

	responses[LIST_URL] = { body: [issue("a/b", 1, "New title")] };
	await run(w);

	assert.equal(w.db.tasks.length, 1);
	assert.equal(task.name, "New title");
	assert.equal(task.note, "https://github.com/a/b/issues/1\nmy own notes");
	assert.equal(task.flagged, true);
	assert.equal(task.containingProject, elsewhere);
});

test("never resurrects or renames a task completed in OmniFocus", async () => {
	const responses = { [LIST_URL]: { body: [issue("a/b", 1, "One")] } };
	const w = createWorld({ responses });
	await run(w);
	w.db.tasks[0].markComplete();

	responses[LIST_URL] = { body: [issue("a/b", 1, "Renamed")] };
	await run(w);

	assert.equal(w.db.tasks.length, 1);
	assert.equal(w.db.tasks[0].name, "One");
	assert.equal(w.db.tasks[0].taskStatus, "Completed");
});

test("issues that leave the labeled set: closed completes, not_planned drops, open/404 left alone", async () => {
	const responses = { [LIST_URL]: { body: [
		issue("a/b", 1, "Done"), issue("a/b", 2, "Won't do"), issue("a/b", 3, "Unlabeled"), issue("a/b", 4, "Deleted"),
	] } };
	const w = createWorld({ responses });
	await run(w);

	responses[LIST_URL] = { body: [] };
	responses[issueUrl("a/b#1")] = { body: issue("a/b", 1, "Done", { state: "closed", state_reason: "completed" }) };
	responses[issueUrl("a/b#2")] = { body: issue("a/b", 2, "Won't do", { state: "closed", state_reason: "not_planned" }) };
	responses[issueUrl("a/b#3")] = { body: issue("a/b", 3, "Unlabeled") };
	// a/b#4 falls through to the fake's 404.
	await run(w);

	assert.deepEqual(w.db.tasks.map(t => t.taskStatus), ["Completed", "Dropped", "Available", "Available"]);
	const msg = w.alerts[1].message;
	assert.match(msg, /1 task\(s\) completed/);
	assert.match(msg, /1 task\(s\) dropped/);
	assert.match(msg, /1 task\(s\) whose issue no longer has the "omnifocus" label/);
	assert.match(msg, /1 task\(s\) whose issue can't be found/);

	// Already-closed tasks aren't re-fetched on the next run.
	const before = w.requests.length;
	await run(w);
	assert.equal(w.requests.length - before, 1 + 2); // list + #3 and #4 still active
});

test("pre-existing untagged tasks that link an issue block duplicates but are never modified", async () => {
	const w = createWorld({
		responses: {
			[LIST_URL]: { body: [issue("kalafut/wwv", 47, "Reduce volume in WWV tone (from GitHub)")] },
			[issueUrl("romshark/templier#15")]: { body: issue("romshark/templier", 15, "x", { state: "closed", state_reason: "completed" }) },
		},
	});
	const inbox = new w.Task("Reduce volume in WWV tone");
	inbox.note = "https://github.com/kalafut/wwv/issues/47\n";
	const upstream = new w.Task("templier etags");
	upstream.note = "https://github.com/romshark/templier/issues/15\n";
	const mention = new w.Task("Fwd: email");
	mention.note = "----- Original message -----\nhttps://github.com/kalafut/wwv/issues/42";

	await run(w);

	assert.equal(w.db.tasks.length, 3);
	assert.equal(w.db.projects.length, 0);
	assert.equal(inbox.name, "Reduce volume in WWV tone");
	assert.equal(upstream.taskStatus, "Available");
	assert.ok(!w.requests.some(r => r.url.includes("templier")));
	assert.match(w.alerts[0].message, /1 labeled issue\(s\) already linked from a task without the "GitHub" tag/);
});

test("adding the GitHub tag to an existing linked task adopts it", async () => {
	const w = createWorld({ responses: { [LIST_URL]: { body: [issue("kalafut/wwv", 47, "Reduce volume")] } } });
	const tag = new w.Tag("GitHub");
	const t = new w.Task("old name");
	t.note = "https://github.com/kalafut/wwv/issues/47";
	t.addTag(tag);
	await run(w);
	assert.equal(w.db.tasks.length, 1);
	assert.equal(t.name, "Reduce volume");
	assert.equal(w.db.tags.length, 1);
});

test("projects are found by their note after being renamed and moved; new repos follow into that folder", async () => {
	const responses = { [LIST_URL]: { body: [issue("Kalafut/Scorekeeper", 1, "One")] } };
	const w = createWorld({ responses });
	await run(w);

	const folder = new w.Folder("Dev");
	const project = w.db.projects[0];
	project.name = "Scorekeeper app";
	project.parentFolder = folder;

	responses[LIST_URL] = { body: [
		issue("kalafut/scorekeeper", 1, "One"), // different case, same repo
		issue("kalafut/scorekeeper", 2, "Two"),
		issue("kalafut/rooksclub", 5, "Five"),
	] };
	await run(w);

	assert.equal(w.db.projects.length, 2);
	assert.deepEqual(tasksIn(w, project).map(t => t.name), ["One", "Two"]);
	assert.equal(w.db.projects[1].name, "rooksclub");
	assert.equal(w.db.projects[1].parentFolder, folder);
});

test("newProjectFolder config places new projects in that folder", async () => {
	const w = createWorld({ responses: { [LIST_URL]: { body: [issue("a/b", 1, "One")] } } });
	const folder = new w.Folder("GitHub");
	w.plugin.CONFIG.newProjectFolder = "GitHub";
	await run(w);
	assert.equal(w.db.projects[0].parentFolder, folder);
});

test("repo allowlist filters issues", async () => {
	const w = createWorld({ responses: { [LIST_URL]: { body: [issue("a/b", 1, "One"), issue("c/d", 2, "Two")] } } });
	w.plugin.CONFIG.repos = ["C/D"];
	await run(w);
	assert.deepEqual(w.db.tasks.map(t => t.name), ["Two"]);
});

test("a GitHub failure part-way through leaves OmniFocus untouched", async () => {
	const responses = { [LIST_URL]: { body: [issue("a/b", 1, "One")] } };
	const w = createWorld({ responses });
	await run(w);

	responses[LIST_URL] = { body: [issue("a/b", 2, "Two")] };
	responses[issueUrl("a/b#1")] = { status: 500, body: { message: "boom" } };
	await run(w);

	assert.equal(w.db.tasks.length, 1);
	assert.equal(w.alerts[1].title, "GitHub sync failed");
	assert.match(w.alerts[1].message, /\(500\): boom/);
});

test("a rejected token is cleared and reported", async () => {
	const w = await run(createWorld({ responses: { [LIST_URL]: { status: 401, body: { message: "Bad credentials" } } } }));
	assert.equal(w.keychain.size, 0);
	assert.equal(w.alerts[0].title, "GitHub sync failed");
	assert.match(w.alerts[0].message, /cleared/);
});

test("cancelling the token prompt does nothing", async () => {
	const w = await run(createWorld({ savedToken: null }));
	assert.equal(w.requests.length, 0);
	assert.equal(w.alerts.length, 0);
});

test("note parsing only looks at the first line", () => {
	const { plugin } = createWorld();
	assert.equal(plugin.issueKeyFromText("https://github.com/A/B/issues/12\nmore"), "a/b#12");
	assert.equal(plugin.issueKeyFromText("  https://github.com/a/b/issues/12#issuecomment-1"), "a/b#12");
	assert.equal(plugin.issueKeyFromText("see\nhttps://github.com/a/b/issues/12"), null);
	assert.equal(plugin.issueKeyFromText("https://github.com/a/b/pull/12"), null);
	assert.equal(plugin.repoKeyFromText("https://github.com/a/b/\n"), "a/b");
	assert.equal(plugin.repoKeyFromText("https://github.com/a/b/issues/1"), null);
});
