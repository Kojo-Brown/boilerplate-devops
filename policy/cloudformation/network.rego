# What may be reachable from the whole internet.
#
# Checkov ships per-port checks for this shape — CKV_AWS_260 for port 80, others
# for 22 and 3389 — and `.checkov.baseline` already carries the port-80 findings
# on the load balancer security groups, because a public ALB listening on 80 to
# redirect to 443 is correct and there is no way to say so to a per-port check.
# Baselining it also silences the check for every *future* port-80 rule anywhere
# in the repository, which is the cost of a baseline.
#
# This rule inverts that: instead of naming the ports that are forbidden, it
# names the three that are allowed and denies every other world-open rule. A new
# `0.0.0.0/0` on 22, 5432 or 6379 is then a failure by default rather than a
# check somebody has to have added.
package cloudformation

# 80 redirects to 443; 8443 is the blue/green *test* listener, which is how a
# release is validated from outside before it takes production traffic.
publicly_reachable_ports := {80, 443, 8443}

world_open_cidrs := {"0.0.0.0/0", "::/0"}

# Ingress rules come in two shapes: inline on the security group, and as a
# standalone `AWS::EC2::SecurityGroupIngress` resource — CDK emits the second
# whenever the rule crosses a construct boundary. A rule that reads only the
# first sees about half of them.
ingress_rules contains entry if {
	some resource in resources
	resource.type == "AWS::EC2::SecurityGroup"
	some rule in object.get(resource.properties, "SecurityGroupIngress", [])
	entry := {"id": resource.id, "type": resource.type, "rule": rule}
}

ingress_rules contains entry if {
	some resource in resources
	resource.type == "AWS::EC2::SecurityGroupIngress"
	entry := {"id": resource.id, "type": resource.type, "rule": resource.properties}
}

world_open(rule) if object.get(rule, "CidrIp", "") in world_open_cidrs

world_open(rule) if object.get(rule, "CidrIpv6", "") in world_open_cidrs

# `IpProtocol: "-1"` is every protocol on every port. CloudFormation lets the
# port fields be omitted with it, so a rule that only compares FromPort/ToPort
# against an allowlist never sees the widest rule anyone can write.
deny contains msg if {
	some entry in ingress_rules
	world_open(entry.rule)
	object.get(entry.rule, "IpProtocol", "") == "-1"

	msg := sprintf(
		"[world-open-all-protocols] %s %s allows every protocol and port from the internet. This is the widest rule CloudFormation can express and it names no port, so a port allowlist never sees it.",
		[entry.type, entry.id],
	)
}

deny contains msg if {
	some entry in ingress_rules
	world_open(entry.rule)
	object.get(entry.rule, "IpProtocol", "") != "-1"

	from := object.get(entry.rule, "FromPort", -1)
	to := object.get(entry.rule, "ToPort", -1)
	not permitted_public_range(from, to)

	msg := sprintf(
		"[world-open-ingress] %s %s opens ports %v-%v to the internet. Only %s may be world-reachable; everything else belongs behind a security group reference or a prefix list.",
		[entry.type, entry.id, from, to, concat(", ", [sprintf("%v", [port]) | some port in sort(publicly_reachable_ports)])],
	)
}

# A single port from the allowlist. A *range* is never permitted even when both
# ends are allowed: `FromPort: 80, ToPort: 443` opens 364 ports between them,
# including 389 and 143, and reads in review like the two ports it names.
permitted_public_range(from, to) if {
	from == to
	from in publicly_reachable_ports
}
