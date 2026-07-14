/** Parse the portable Agent Skill metadata on both LF and CRLF checkouts. */
export function parseSkillFrontmatter(source, skillDirectory) {
  const match = source.match(
    /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---(?:\r?\n|$)/,
  );
  if (!match) throw new Error(`Invalid skill frontmatter: ${skillDirectory}`);
  return { name: match[1], description: match[2] };
}
