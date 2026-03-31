const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedContainerSnapshots, seedServiceGroups, seedGroupMembers } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');
const queries = require('../../hub/src/web/group-queries');

describe('group queries', () => {
  let db, restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  describe('CRUD', () => {
    it('should create and retrieve a group', () => {
      const { id } = queries.createGroup(db, { name: 'Media Stack', description: 'Movies & TV', icon: '🎬', color: '#ff5722' });
      const group = queries.getGroup(db, id);
      assert.equal(group.name, 'Media Stack');
      assert.equal(group.description, 'Movies & TV');
      assert.equal(group.icon, '🎬');
      assert.equal(group.source, 'manual');
    });

    it('should list groups sorted by name', () => {
      queries.createGroup(db, { name: 'Zebra' });
      queries.createGroup(db, { name: 'Alpha' });
      const groups = queries.getGroups(db);
      assert.equal(groups.length, 2);
      assert.equal(groups[0].name, 'Alpha');
    });

    it('should update specific fields', () => {
      const { id } = queries.createGroup(db, { name: 'Test', description: 'old' });
      queries.updateGroup(db, id, { description: 'new', color: '#000' });
      const group = queries.getGroup(db, id);
      assert.equal(group.description, 'new');
      assert.equal(group.color, '#000');
      assert.equal(group.name, 'Test'); // unchanged
    });

    it('should delete a group and cascade members', () => {
      const { id } = queries.createGroup(db, { name: 'Test' });
      queries.addGroupMember(db, id, 'local', 'nginx');
      queries.deleteGroup(db, id);
      assert.equal(queries.getGroup(db, id), null);
      // Members should be gone too (cascade)
      const members = db.prepare('SELECT * FROM service_group_members WHERE group_id = ?').all(id);
      assert.equal(members.length, 0);
    });
  });

  describe('members', () => {
    it('should add and list members with container data', () => {
      const { id } = queries.createGroup(db, { name: 'Web' });
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'running', cpu: 5, mem: 50, at: ts(NOW) },
      ]);
      queries.addGroupMember(db, id, 'local', 'nginx');
      const detail = queries.getGroupDetail(db, id);
      assert.equal(detail.members.length, 1);
      assert.equal(detail.members[0].container_name, 'nginx');
      assert.equal(detail.members[0].status, 'running');
    });

    it('should remove a member', () => {
      const { id } = queries.createGroup(db, { name: 'Web' });
      queries.addGroupMember(db, id, 'local', 'nginx');
      queries.removeGroupMember(db, id, 'local', 'nginx');
      const detail = queries.getGroupDetail(db, id);
      assert.equal(detail.members.length, 0);
    });

    it('should prevent duplicate membership', () => {
      const { id } = queries.createGroup(db, { name: 'Web' });
      queries.addGroupMember(db, id, 'local', 'nginx');
      const result = queries.addGroupMember(db, id, 'local', 'nginx');
      assert.equal(result.added, false);
    });

    it('should get groups for a container', () => {
      const { id: g1 } = queries.createGroup(db, { name: 'Web' });
      const { id: g2 } = queries.createGroup(db, { name: 'Frontend' });
      queries.addGroupMember(db, g1, 'local', 'nginx');
      queries.addGroupMember(db, g2, 'local', 'nginx');
      const groups = queries.getContainerGroups(db, 'local', 'nginx');
      assert.equal(groups.length, 2);
    });
  });

  describe('autoAssignGroups', () => {
    it('should auto-create group from compose label', () => {
      const containers = [
        { name: 'nginx', labels: JSON.stringify({ 'com.docker.compose.project': 'media-stack' }) },
      ];
      queries.autoAssignGroups(db, 'local', containers);
      const groups = queries.getGroups(db);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].name, 'media-stack');
      assert.equal(groups[0].source, 'compose');
    });

    it('should auto-create group from insightd.group label', () => {
      const containers = [
        { name: 'plex', labels: JSON.stringify({ 'insightd.group': 'media' }) },
      ];
      queries.autoAssignGroups(db, 'local', containers);
      const groups = queries.getGroups(db);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].name, 'media');
    });

    it('should not override manual membership', () => {
      const { id } = queries.createGroup(db, { name: 'media' });
      queries.addGroupMember(db, id, 'local', 'plex', 'manual');

      const containers = [
        { name: 'plex', labels: JSON.stringify({ 'insightd.group': 'media' }) },
      ];
      queries.autoAssignGroups(db, 'local', containers);

      const members = db.prepare('SELECT source FROM service_group_members WHERE group_id = ? AND container_name = ?').get(id, 'plex');
      assert.equal(members.source, 'manual'); // Not overwritten
    });

    it('should handle containers with no labels gracefully', () => {
      const containers = [
        { name: 'redis', labels: null },
        { name: 'postgres', labels: '{}' },
      ];
      queries.autoAssignGroups(db, 'local', containers);
      assert.equal(queries.getGroups(db).length, 0);
    });
  });

  describe('getGroups with aggregates', () => {
    it('should include member count and running count', () => {
      const { id } = queries.createGroup(db, { name: 'Web' });
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'running', cpu: 5, mem: 50, at: ts(NOW) },
        { name: 'redis', status: 'exited', cpu: 0, mem: 0, at: ts(NOW) },
      ]);
      queries.addGroupMember(db, id, 'local', 'nginx');
      queries.addGroupMember(db, id, 'local', 'redis');

      const groups = queries.getGroups(db);
      assert.equal(groups[0].member_count, 2);
      assert.equal(groups[0].running_count, 1);
    });
  });
});
