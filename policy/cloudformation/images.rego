# Container images referenced by a task definition.
#
# `docs/dependency-pinning.md` already argues why a floating tag is a
# supply-chain problem, and `aws/cdk/lib/base-images.ts` holds the third-party
# images this repository runs as digests. Neither of those reaches a task
# definition assembled from a prop: `ecs.ContainerImage.fromRegistry(uri)` puts
# whatever string it is handed straight into the template.
#
# What a mutable tag does to ECS specifically: the tag resolves once per task
# placement, not once per deployment. Two tasks in the same service can be
# running different images while CloudFormation reports no drift, a scale-out
# an hour after the deploy can pull something the deploy never saw, and a
# rollback to the previous task definition rolls back to the same moving tag.
package cloudformation

image_bearing_types := {"AWS::ECS::TaskDefinition"}

deny contains msg if {
	some resource in resources
	resource.type in image_bearing_types

	some container in object.get(resource.properties, "ContainerDefinitions", [])
	image := object.get(container, "Image", null)
	is_string(image)
	not contains(image, "@sha256:")

	msg := sprintf(
		"[image-not-digest-pinned] %s %s runs container %q from %q, which is a mutable reference. ECS resolves a tag at task placement, so two tasks in one service can run different images with no CloudFormation drift. Deploy the digest the build pushed.",
		[resource.type, resource.id, object.get(container, "Name", "<unnamed>"), image],
	)
}

# An image built from an intrinsic — `{"Fn::Sub": "${Repo}:${Tag}"}` — is not
# checkable here: the string does not exist until the stack is deployed. The
# rule above skips it because `is_string` fails, and this one records that it
# did rather than leaving a silent hole. It is a `deny` and not a `warn` for the
# reason `docs/policy-as-code.md` §4 gives: a warning is a finding nobody is
# paged by. A template that genuinely needs a deploy-time image reference should
# resolve it to a digest in the pipeline and pass it in as a parameter value.
deny contains msg if {
	some resource in resources
	resource.type in image_bearing_types

	some container in object.get(resource.properties, "ContainerDefinitions", [])
	image := object.get(container, "Image", null)
	image != null
	resolved_at_deploy_time(image)

	msg := sprintf(
		"[image-resolved-at-deploy-time] %s %s builds container %q's image from a CloudFormation intrinsic, so no gate in this repository can tell what it will pull. Resolve the digest in the pipeline and pass it in.",
		[resource.type, resource.id, object.get(container, "Name", "<unnamed>")],
	)
}
