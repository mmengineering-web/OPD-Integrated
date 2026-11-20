// Reads the person's role from one project (concept 4.2). Throws on a read error; the caller treats that as "role unknown, database RLS decides".
export async function readProfile(client, project, user) {
  const pr = project.profile;
  if (pr.type === "dash") {
    const { data, error } = await client.schema("dash").rpc("me");
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return row ? { found: true, role: row.role, active: true, name: row.name ?? null } : { found: false };
  }
  const { data, error } = await client.from(pr.type === "exp" ? "exp_profile" : "op_profile").select("*").eq("user_id", user.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { found: false };
  return {
    found: true,
    role: data.role,
    active: (data.is_active ?? data.active) !== false,
    name: data.full_name ?? data.name ?? null,
    forms: Array.isArray(data.input_forms) ? data.input_forms : null,
  };
}
