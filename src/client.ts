const BASE_URL = "https://herbeth-immobilier.crypto-extranet.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export interface CurrentUser {
  id: number;
  ref: string;
  login: string;
  nom: string;
  nom_copro: string;
  ref_copro: string;
  id_copro: number;
  identites_id: number;
  acl_roles_id: string;
  acl_roles_libelle: string;
  membre_conseil: number;
  president_conseil: number;
  date_derniere_connexion: string;
  expiration: number;
  [key: string]: unknown;
}

export interface Classeur {
  id: number;
  nom: string;
  parent: number | null;
  fileCount: number;
  icon: string;
  dateActualisation: string | null;
}

export interface DocumentEntry {
  id: number;
  documents_classeurs_id: number;
  file_name: string;
  title: string;
  mime_type: string;
  date_commit: string;
  date_commit_libelle: string;
  thumb_url: string;
  [key: string]: unknown;
}

export interface ClasseurListing {
  allClasseurs: Record<string, Classeur> | Classeur[];
  data: {
    Classeur: { id: number; nom: string; ref?: string; metier?: string } | unknown[];
    Classeurs: Classeur[];
    Documents: DocumentEntry[];
  };
  totalItemCount: number;
  resultsCount: number;
}

export type Space = "coproprietaire" | "conseil-syndical";

export class HerbethClient {
  private cookies = new Map<string, string>();
  private loggedIn = false;

  constructor(
    private readonly login: string,
    private readonly password: string,
  ) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbSetCookie(res: Response): void {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  private async request(
    path: string,
    init: Omit<RequestInit, "headers"> & {
      referer?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const { referer, headers, ...rest } = init;
    const merged: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      "user-agent": USER_AGENT,
      referer: referer ?? `${BASE_URL}/xnet`,
      ...(this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {}),
      ...headers,
    };
    const res = await fetch(`${BASE_URL}${path}`, { ...rest, headers: merged });
    this.absorbSetCookie(res);
    return res;
  }

  async authenticate(): Promise<void> {
    const res = await this.request("/authenticate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE_URL,
        referer: `${BASE_URL}/connexion`,
      },
      body: JSON.stringify({ login: this.login, password: this.password }),
    });
    if (!res.ok) {
      throw new Error(`Authentication failed: ${res.status} ${res.statusText}`);
    }
    if (this.cookies.size === 0) {
      throw new Error("Authentication returned no session cookie");
    }
    this.loggedIn = true;
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.loggedIn) await this.authenticate();
  }

  private async getJson<T>(path: string): Promise<T> {
    await this.ensureAuthenticated();
    let res = await this.request(path);
    if (res.status === 401 || res.status === 403) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.authenticate();
      res = await this.request(path);
    }
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async getCurrentUser(): Promise<CurrentUser> {
    const body = await this.getJson<{ success: boolean; user: CurrentUser }>(
      "/api/current-logged-user",
    );
    return body.user;
  }

  async listClasseurs(space: Space = "conseil-syndical"): Promise<ClasseurListing> {
    return this.getJson<ClasseurListing>(
      `/api/extranet/${space}/documents/classeur?sortColumn=date_commit&classeur=null&sortOrder=DESC`,
    );
  }

  async listDocumentsInClasseur(
    classeurId: number,
    space: Space = "conseil-syndical",
  ): Promise<ClasseurListing> {
    return this.getJson<ClasseurListing>(
      `/api/extranet/${space}/documents/classeur/${classeurId}?sortColumn=date_commit&classeur=null&sortOrder=DESC`,
    );
  }

  async downloadFile(
    documentId: number,
  ): Promise<{ bytes: Uint8Array; filename: string | null; mimeType: string }> {
    await this.ensureAuthenticated();
    let res = await this.request(`/api/extranet/documents/downloadFile/${documentId}`, {
      headers: { accept: "*/*" },
    });
    if (res.status === 401 || res.status === 403) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.authenticate();
      res = await this.request(`/api/extranet/documents/downloadFile/${documentId}`, {
        headers: { accept: "*/*" },
      });
    }
    if (!res.ok) {
      throw new Error(`Download ${documentId} failed: ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const envelope = (await res.json()) as {
        file_name?: string;
        mime_type?: string;
        base64?: string;
      };
      if (!envelope.base64) {
        throw new Error(`Download ${documentId}: JSON envelope missing base64 field`);
      }
      const bytes = Uint8Array.from(Buffer.from(envelope.base64, "base64"));
      return {
        bytes,
        filename: envelope.file_name ?? null,
        mimeType: envelope.mime_type ?? "application/octet-stream",
      };
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      bytes: buf,
      filename: match?.[1] ? decodeURIComponent(match[1]) : null,
      mimeType: contentType || "application/octet-stream",
    };
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    await this.request("/api/deconnexion");
    this.cookies.clear();
    this.loggedIn = false;
  }
}

export function classeursAsArray(listing: ClasseurListing): Classeur[] {
  return Array.isArray(listing.allClasseurs)
    ? listing.allClasseurs
    : Object.values(listing.allClasseurs);
}
