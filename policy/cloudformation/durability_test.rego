package cloudformation

database(environment, properties) := {
	"Type": "AWS::RDS::DBInstance",
	"Properties": object.union(
		properties,
		{"Tags": [
			{"Key": "ManagedBy", "Value": "CDK"},
			{"Key": "Stack", "Value": "RdsStack"},
			{"Key": "Environment", "Value": environment},
		]},
	),
}

production_defaults := {
	"StorageEncrypted": true,
	"MultiAZ": true,
	"DeletionProtection": true,
	"BackupRetentionPeriod": 7,
}

test_compliant_production_database_passes if {
	messages := deny with input as with_resource("Db", database("production", production_defaults))

	count(messages) == 0
}

test_unencrypted_database_is_denied if {
	messages := deny with input as with_resource(
		"Db",
		database("production", object.union(production_defaults, {"StorageEncrypted": false})),
	)

	rule_ids(messages) == {"database-not-encrypted"}
}

# Encryption is the one rule here that does not care which environment it is.
test_unencrypted_preview_database_is_denied if {
	messages := deny with input as with_resource(
		"Db",
		database("preview", {"StorageEncrypted": false}),
	)

	rule_ids(messages) == {"database-not-encrypted"}
}

test_production_single_az_is_denied if {
	messages := deny with input as with_resource(
		"Db",
		database("production", object.union(production_defaults, {"MultiAZ": false})),
	)

	rule_ids(messages) == {"production-database-single-az"}
}

test_production_without_deletion_protection_is_denied if {
	messages := deny with input as with_resource(
		"Db",
		database("production", object.union(production_defaults, {"DeletionProtection": false})),
	)

	rule_ids(messages) == {"production-database-deletable"}
}

test_production_backup_window_below_floor_is_denied if {
	messages := deny with input as with_resource(
		"Db",
		database("production", object.union(production_defaults, {"BackupRetentionPeriod": 1})),
	)

	rule_ids(messages) == {"production-database-backup-window"}
}

# CDK omits `BackupRetentionPeriod` when the prop is not given and RDS then
# defaults it to 0, which disables automated backups. An omitted property must
# read as 0 here, not as "unknown, skip".
test_production_without_backup_property_is_denied if {
	messages := deny with input as with_resource("Db", database("production", {
		"StorageEncrypted": true,
		"MultiAZ": true,
		"DeletionProtection": true,
	}))

	rule_ids(messages) == {"production-database-backup-window"}
}

# A preview database is single-AZ, deletable and unbacked on purpose. This is
# the case a checker with no notion of environment cannot express, and the whole
# reason these four rules live here rather than in the Checkov baseline.
test_preview_database_is_held_only_to_encryption if {
	messages := deny with input as with_resource("Db", database("preview", {
		"StorageEncrypted": true,
		"MultiAZ": false,
		"DeletionProtection": false,
		"BackupRetentionPeriod": 0,
	}))

	count(messages) == 0
}

test_staging_database_is_held_only_to_encryption if {
	messages := deny with input as with_resource("Db", database("staging", {
		"StorageEncrypted": true,
		"MultiAZ": false,
		"DeletionProtection": false,
		"BackupRetentionPeriod": 7,
	}))

	count(messages) == 0
}

test_production_cluster_is_covered_as_well_as_instance if {
	messages := deny with input as with_resource("Cluster", {
		"Type": "AWS::RDS::DBCluster",
		"Properties": {
			"StorageEncrypted": true,
			"MultiAZ": true,
			"DeletionProtection": false,
			"BackupRetentionPeriod": 7,
			"Tags": [
				{"Key": "ManagedBy", "Value": "CDK"},
				{"Key": "Stack", "Value": "RdsStack"},
				{"Key": "Environment", "Value": "production"},
			],
		},
	})

	rule_ids(messages) == {"production-database-deletable"}
}
