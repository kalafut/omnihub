// A small in-memory stand-in for the parts of the OmniFocus automation API
// the plug-in uses, plus a loader that evaluates the plug-in against it.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PLUGIN = path.join(__dirname, "..", "omnihub.omnijs");

function withByName(items) {
	const arr = [...items];
	arr.byName = name => arr.find(x => x.name === name) || null;
	return arr;
}

function createWorld({ responses = {}, savedToken = "tok" } = {}) {
	let nextId = 1;
	const db = { folders: [], projects: [], tasks: [], tags: [] };
	const alerts = [];
	const requests = [];
	const keychain = new Map(savedToken ? [["omnihub-github", { user: "github", password: savedToken }]] : []);

	const TaskStatus = { Available: "Available", Completed: "Completed", Dropped: "Dropped" };

	class Tag {
		constructor(name) {
			this.name = name;
			this.id = { primaryKey: `tag${nextId++}` };
			db.tags.push(this);
		}
	}

	class Folder {
		constructor(name) {
			this.name = name;
			this.id = { primaryKey: `folder${nextId++}` };
			db.folders.push(this);
		}
		get ending() { return { kind: "folder", container: this }; }
	}

	class Project {
		constructor(name, position) {
			this.name = name;
			this.note = "";
			this.id = { primaryKey: `project${nextId++}` };
			this.parentFolder = position ? position.container : null;
			db.projects.push(this);
		}
		get ending() { return { kind: "project", container: this }; }
		get tasks() { return db.tasks.filter(t => t.containingProject === this); }
	}

	class Task {
		constructor(name, position) {
			this.name = name;
			this.note = "";
			this.id = { primaryKey: `task${nextId++}` };
			this.containingProject = position ? position.container : null;
			this.taskStatus = TaskStatus.Available;
			this._tags = [];
			db.tasks.push(this);
		}
		// Return fresh copies of the tag wrappers to mimic bridged objects
		// that aren't === to each other.
		get tags() { return this._tags.map(t => ({ name: t.name, id: { ...t.id } })); }
		addTag(tag) { if (!this._tags.includes(tag)) this._tags.push(tag); }
		markComplete() { this.taskStatus = TaskStatus.Completed; return this; }
		drop(allOccurrences) { this.taskStatus = TaskStatus.Dropped; }
	}
	Task.Status = TaskStatus;

	class FetchRequest {
		static fromString(url) { const r = new FetchRequest(); r.url = url; return r; }
		async fetch() {
			requests.push({ url: this.url, method: this.method, headers: this.headers });
			const handler = responses[this.url];
			if (!handler) return { statusCode: 404, bodyString: '{"message":"Not Found"}', headers: {} };
			const r = typeof handler === "function" ? handler(this) : handler;
			return {
				statusCode: r.status || 200,
				bodyString: typeof r.body === "string" ? r.body : JSON.stringify(r.body),
				headers: r.headers || {},
			};
		}
	}

	class Alert {
		constructor(title, message) { this.title = title; this.message = message; }
		async show() { alerts.push({ title: this.title, message: this.message }); return 0; }
	}

	class Credentials {
		read(service) { return keychain.get(service) || null; }
		write(service, user, password) { keychain.set(service, { user, password }); }
		remove(service) { keychain.delete(service); }
	}

	class Form {
		constructor() { this.fields = []; this.values = {}; }
		addField(f) { this.fields.push(f); }
		async show() { throw new Error("cancelled"); }
	}
	Form.Field = { Password: class { constructor(key) { this.key = key; } } };

	const PlugIn = { Action: class { constructor(fn) { this.perform = fn; } } };

	const context = {
		Tag, Folder, Project, Task, Alert, Credentials, Form, PlugIn,
		URL: { FetchRequest },
		module: { exports: {} },
		JSON, Map, Set, Error, String, Boolean, encodeURIComponent,
	};
	Object.defineProperty(context, "flattenedTasks", { get: () => withByName(db.tasks) });
	Object.defineProperty(context, "flattenedProjects", { get: () => withByName(db.projects) });
	Object.defineProperty(context, "flattenedFolders", { get: () => withByName(db.folders) });
	Object.defineProperty(context, "flattenedTags", { get: () => withByName(db.tags) });

	vm.createContext(context);
	vm.runInContext(fs.readFileSync(PLUGIN, "utf8"), context, { filename: PLUGIN });
	const plugin = context.module.exports;

	return { db, alerts, requests, keychain, plugin, Task, Project, Folder, Tag };
}

module.exports = { createWorld };
