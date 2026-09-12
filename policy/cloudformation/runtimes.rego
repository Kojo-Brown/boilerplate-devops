# Lambda managed runtimes.
#
# A deprecated runtime is the quietest thing in this pack. Nothing fails: the
# function keeps running for months on a runtime that no longer receives
# security patches, AWS emails an account contact who is a distribution list,
# and the first hard stop is the day the runtime can no longer be *updated* —
# at which point the function cannot be redeployed at all, and the discovery is
# made by whoever is shipping the fix during an incident.
#
# The list is a maintenance burden by design. Somebody has to add a runtime
# before it can be used, which is the moment to check that the one being
# replaced is actually gone from every stack. Keeping it accurate is the
# subscription fee for the check; letting it drift open is how the check stops
# being one.
package cloudformation

supported_lambda_runtimes := {
	"nodejs22.x",
	"nodejs24.x",
	"python3.12",
	"python3.13",
	"provided.al2023",
}

deny contains msg if {
	some resource in resources
	resource.type == "AWS::Lambda::Function"

	runtime := object.get(resource.properties, "Runtime", null)
	is_string(runtime)
	not runtime in supported_lambda_runtimes

	msg := sprintf(
		"[lambda-runtime-unsupported] %s %s runs on %q, which is not in this repository's supported set (%s). Add it there deliberately, or move the function; a deprecated runtime stops being patched long before it stops working.",
		[resource.type, resource.id, runtime, concat(", ", sort(supported_lambda_runtimes))],
	)
}

# A function packaged as a container image has no `Runtime`, and `PackageType:
# Image` is how CloudFormation says so. Anything else with no runtime is a
# template this rule cannot read, which is reported rather than skipped — a
# silently exempted function is indistinguishable from a supported one.
deny contains msg if {
	some resource in resources
	resource.type == "AWS::Lambda::Function"

	object.get(resource.properties, "Runtime", null) == null
	object.get(resource.properties, "PackageType", "Zip") != "Image"

	msg := sprintf(
		"[lambda-runtime-unset] %s %s declares neither a Runtime nor PackageType: Image, so nothing here can tell what it executes on.",
		[resource.type, resource.id],
	)
}
