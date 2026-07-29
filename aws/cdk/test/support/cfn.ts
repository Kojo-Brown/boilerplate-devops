/**
 * Helpers for asserting on synthesized CloudFormation values that contain
 * intrinsic functions.
 *
 * Any value built from a CDK token — `stack.partition`, `stack.region`, a
 * resource `ref`, an `Fn::GetAtt` — synthesizes to an `Fn::Join` object rather
 * than a plain string. `Match.stringLikeRegexp` and `Match.serializedJson` only
 * accept plain strings, so assertions written against the "obvious" string form
 * silently never match. Flattening the intrinsic to a readable string keeps
 * those assertions expressive without weakening them.
 */

/** Placeholder substituted for each unresolved intrinsic inside a joined value. */
export const TOKEN = '<token>';

/**
 * Render a synthesized template value as a string.
 *
 * Plain strings pass through. `Fn::Join` is concatenated with its delimiter,
 * with any nested intrinsic replaced by {@link TOKEN} so the literal segments
 * around it stay assertable. Everything else is JSON-encoded.
 */
export const flattenIntrinsic = (value: unknown): string => {
  if (typeof value === 'string') return value;

  if (value !== null && typeof value === 'object' && 'Fn::Join' in value) {
    const [delimiter, parts] = (value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
    return parts.map(flattenIntrinsic).join(delimiter);
  }

  if (value !== null && typeof value === 'object') return TOKEN;

  return JSON.stringify(value);
};

/**
 * Find a stack output by its `Export.Name`.
 *
 * CloudFormation output logical IDs must be alphanumeric, so CDK strips every
 * other character from the construct id — an output created as
 * `SecretArn-stripe-api-key` lands in the template as `SecretArnstripeapikey`.
 * The export name is the stable, intentional contract, so look outputs up by it.
 */
export const outputByExportName = (
  template: { findOutputs: (id: string) => Record<string, Record<string, unknown>> },
  exportName: string,
): Record<string, unknown> | undefined =>
  Object.values(template.findOutputs('*')).find(
    (output) => (output.Export as { Name?: unknown } | undefined)?.Name === exportName,
  );

/** The `Properties` block of every resource of a given type. */
export const resourceProps = (
  template: { findResources: (type: string) => Record<string, Record<string, unknown>> },
  resourceType: string,
): Record<string, unknown>[] =>
  Object.values(template.findResources(resourceType)).map(
    (resource) => (resource.Properties ?? {}) as Record<string, unknown>,
  );

/**
 * Managed policy ARNs attached to a role, flattened to strings.
 *
 * AWS-managed policy ARNs are built with `stack.partition`, so each entry
 * synthesizes to an `Fn::Join` rather than the literal `arn:aws:iam::aws:policy/...`.
 */
export const managedPolicyArns = (roleProps: Record<string, unknown>): string[] =>
  ((roleProps.ManagedPolicyArns as unknown[]) ?? []).map(flattenIntrinsic);

/**
 * Collect one property from every resource of a given type, each flattened to a
 * string via {@link flattenIntrinsic}.
 *
 * Example:
 *   expect(flattenedProps(template, 'AWS::SecurityHub::Standard', 'StandardsArn'))
 *     .toContainEqual(expect.stringContaining('pci-dss/v/3.2.1'));
 */
export const flattenedProps = (
  template: { findResources: (type: string) => Record<string, Record<string, unknown>> },
  resourceType: string,
  propertyName: string,
): string[] =>
  Object.values(template.findResources(resourceType)).map((resource) =>
    flattenIntrinsic((resource.Properties as Record<string, unknown>)[propertyName]),
  );
