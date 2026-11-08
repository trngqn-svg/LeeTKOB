export type Role = "admin" | "ta" | "student";

export interface User {
  id: string;
  role: Role;
  token: string;
  classIds: string[];
}

export interface Publication {
  publishedAt: string;
  publishedBy: string;
  marksPublished: number;
  note: string | null;
}

export interface Lab {
  id: string;
  classId: string;
  // shortcut: a count instead of the review queue; PA#3 replaces it with real queue items.
  pendingReviews: number;
  judgedSubmissions: number;
  publication: Publication | null;
}

export interface StoredResponse {
  bodyHash: string;
  status: number;
  body: unknown;
}

// shortcut: in-memory, single process, no key expiry; move to the database in PA#3.
export interface Store {
  usersByToken: Map<string, User>;
  labs: Map<string, Lab>;
  idempotency: Map<string, StoredResponse>;
  now: () => Date;
}

export function createStore(seed: {
  users: User[];
  labs: Lab[];
  now?: () => Date;
}): Store {
  return {
    usersByToken: new Map(seed.users.map((u) => [u.token, u])),
    labs: new Map(seed.labs.map((l) => [l.id, l])),
    idempotency: new Map(),
    now: seed.now ?? (() => new Date()),
  };
}
