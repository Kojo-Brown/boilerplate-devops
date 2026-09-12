package cloudformation

function(properties) := {"Type": "AWS::Lambda::Function", "Properties": object.union(
	properties,
	{"Tags": [
		{"Key": "ManagedBy", "Value": "CDK"},
		{"Key": "Stack", "Value": "DoraMetricsStack"},
	]},
)}

test_supported_runtime_passes if {
	messages := deny with input as with_resource("Fn", function({"Runtime": "nodejs22.x"}))

	count(messages) == 0
}

test_deprecated_runtime_is_denied if {
	messages := deny with input as with_resource("Fn", function({"Runtime": "nodejs18.x"}))

	rule_ids(messages) == {"lambda-runtime-unsupported"}
}

test_unknown_runtime_is_denied if {
	messages := deny with input as with_resource("Fn", function({"Runtime": "python3.9"}))

	rule_ids(messages) == {"lambda-runtime-unsupported"}
}

test_container_packaged_function_has_no_runtime_and_passes if {
	messages := deny with input as with_resource("Fn", function({"PackageType": "Image"}))

	count(messages) == 0
}

# The gap this closes: a zip function with no `Runtime` is not a function this
# pack can vouch for, and skipping it makes it indistinguishable from one on a
# supported runtime.
test_function_without_runtime_or_image_packaging_is_denied if {
	messages := deny with input as with_resource("Fn", function({}))

	rule_ids(messages) == {"lambda-runtime-unset"}
}

test_zip_packaging_stated_explicitly_still_needs_a_runtime if {
	messages := deny with input as with_resource("Fn", function({"PackageType": "Zip"}))

	rule_ids(messages) == {"lambda-runtime-unset"}
}
