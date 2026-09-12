package cloudformation

security_group(rules) := {
	"Type": "AWS::EC2::SecurityGroup",
	"Properties": {
		"SecurityGroupIngress": rules,
		"Tags": [
			{"Key": "ManagedBy", "Value": "CDK"},
			{"Key": "Stack", "Value": "EcsStack-Production"},
			{"Key": "Environment", "Value": "production"},
		],
	},
}

https_from_anywhere := {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "CidrIp": "0.0.0.0/0"}

test_public_web_ports_pass if {
	messages := deny with input as with_resource("AlbSg", security_group([
		{"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "CidrIp": "0.0.0.0/0"},
		https_from_anywhere,
		{"IpProtocol": "tcp", "FromPort": 8443, "ToPort": 8443, "CidrIpv6": "::/0"},
	]))

	count(messages) == 0
}

test_world_open_ssh_is_denied if {
	messages := deny with input as with_resource("AlbSg", security_group([
		https_from_anywhere,
		{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "CidrIp": "0.0.0.0/0"},
	]))

	rule_ids(messages) == {"world-open-ingress"}
	count(messages) == 1
}

test_world_open_postgres_is_denied if {
	messages := deny with input as with_resource("DbSg", security_group([{
		"IpProtocol": "tcp",
		"FromPort": 5432,
		"ToPort": 5432,
		"CidrIp": "0.0.0.0/0",
	}]))

	rule_ids(messages) == {"world-open-ingress"}
}

test_ipv6_is_checked_as_well_as_ipv4 if {
	messages := deny with input as with_resource("DbSg", security_group([{
		"IpProtocol": "tcp",
		"FromPort": 6379,
		"ToPort": 6379,
		"CidrIpv6": "::/0",
	}]))

	rule_ids(messages) == {"world-open-ingress"}
}

# Both ends of the range are on the allowlist and everything between them is
# not. A rule that checks membership port by port lets this through.
test_range_spanning_allowed_ports_is_denied if {
	messages := deny with input as with_resource("AlbSg", security_group([{
		"IpProtocol": "tcp",
		"FromPort": 80,
		"ToPort": 443,
		"CidrIp": "0.0.0.0/0",
	}]))

	rule_ids(messages) == {"world-open-ingress"}
}

# `IpProtocol: "-1"` may legally omit the port fields, so it is the one rule a
# port allowlist never sees.
test_all_protocols_from_anywhere_is_denied if {
	messages := deny with input as with_resource("AlbSg", security_group([{
		"IpProtocol": "-1",
		"CidrIp": "0.0.0.0/0",
	}]))

	rule_ids(messages) == {"world-open-all-protocols"}
	count(messages) == 1
}

test_narrow_cidr_on_an_admin_port_passes if {
	messages := deny with input as with_resource("BastionSg", security_group([{
		"IpProtocol": "tcp",
		"FromPort": 22,
		"ToPort": 22,
		"CidrIp": "10.0.0.0/16",
	}]))

	count(messages) == 0
}

test_security_group_reference_passes if {
	messages := deny with input as with_resource("AppSg", security_group([{
		"IpProtocol": "tcp",
		"FromPort": 8080,
		"ToPort": 8080,
		"SourceSecurityGroupId": "sg-0123456789abcdef0",
	}]))

	count(messages) == 0
}

# CDK emits a standalone `AWS::EC2::SecurityGroupIngress` whenever the rule
# crosses a construct boundary. Sixteen of this repository's ingress rules are
# that shape, so a policy reading only the inline list sees about half of them.
test_standalone_ingress_resource_is_checked if {
	messages := deny with input as with_resource("DbIngress", {
		"Type": "AWS::EC2::SecurityGroupIngress",
		"Properties": {
			"IpProtocol": "tcp",
			"FromPort": 3389,
			"ToPort": 3389,
			"CidrIp": "0.0.0.0/0",
		},
	})

	rule_ids(messages) == {"world-open-ingress"}
}

test_security_group_with_no_ingress_passes if {
	messages := deny with input as with_resource("EmptySg", {
		"Type": "AWS::EC2::SecurityGroup",
		"Properties": {"Tags": [
			{"Key": "ManagedBy", "Value": "CDK"},
			{"Key": "Stack", "Value": "EcsStack-Production"},
		]},
	})

	count(messages) == 0
}
