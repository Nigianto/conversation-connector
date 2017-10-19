'use strict';

const assert = require('assert');
const cloudant = require('cloudant');
const crypto = require('crypto');
const nock = require('nock');

const actionSlackDeploy = require('./../../../../channels/slack/deploy/index.js');

const cloudantUrl = 'https://account:password@account.cloudant.com';
const cloudantAuthDbName = 'sample_auth_db';
const cloudantAuthKey = 'KXXXXXXXXX';
const slackClientId = 'sample_client_id';
const slackClientSecret = 'sample_client_secret';
const slackVerificationToken = 'sample_verification_token';

const owHost = 'https://openwhisk.ng.bluemix.net';
const slackHost = 'https://slack.com';
const cloudantHost = cloudantUrl;
const realNamespace = process.env.__OW_NAMESPACE;
const userNamespace = 'sampleorganization_samplespace';

const mockError = 'mock-error';

const packageContent = {
  annotations: [
    {
      key: 'unused',
      value: 'unused'
    },
    {
      key: 'cloudant_url',
      value: cloudantUrl
    },
    {
      key: 'cloudant_auth_key',
      value: cloudantAuthKey
    },
    {
      key: 'cloudant_auth_dbname',
      value: cloudantAuthDbName
    }
  ]
};

const authDocContent = {
  slack: {
    client_id: slackClientId,
    client_secret: slackClientSecret,
    verification_token: slackVerificationToken
  }
};

describe('Slack Deploy Unit Tests', () => {
  let params;

  before(() => {
    process.env.__OW_ACTION_NAME = `${userNamespace}/slack/deploy`;
    process.env.__OW_NAMESPACE = userNamespace;
  });

  beforeEach(() => {
    params = {
      state: encodeURIComponent(
        JSON.stringify({
          signature: createHmacKey(slackClientId, slackClientSecret),
          redirect_url: 'sample_redirect_url'
        })
      ),
      code: 'sample_oauth_code'
    };

    createOpenwhiskMock();
    createSlackMock();
    createCloudantMock();
  });

  it('validate main works', () => {
    return actionSlackDeploy
      .main(params)
      .then(result => {
        assert.deepEqual(JSON.parse(result.body), {
          code: 200,
          message: 'Authorized successfully!'
        });
      })
      .catch(error => {
        assert(false, error);
      });
  });

  it('validate main works with a success url', () => {
    const successUrl = 'https://ibm.com/';

    params.state = encodeURIComponent(
      JSON.stringify({
        signature: createHmacKey(slackClientId, slackClientSecret),
        redirect_url: 'sample_redirect_url',
        success_url: successUrl
      })
    );

    return actionSlackDeploy
      .main(params)
      .then(result => {
        assert.equal(
          result.body,
          `<html><script>window.location.href = "${successUrl}?code=200&message=Authorized successfully!";</script></html>`
        );
      })
      .catch(error => {
        assert(false, error);
      });
  });

  it('validate error when not enough input parameters', () => {
    delete params.state;

    return actionSlackDeploy
      .main(params)
      .then(() => {
        assert(false, 'Action succeeded unexpectedly.');
      })
      .catch(error => {
        assert.deepEqual(JSON.parse(error.body), {
          code: 400,
          message: 'No verification state provided.'
        });
      });
  });

  it('validate error when hmac key is incorrect', () => {
    params.state = encodeURIComponent(
      JSON.stringify({
        signature: 'bad_hmac_signature',
        redirect_url: 'sample_redirect_url'
      })
    );

    return actionSlackDeploy
      .main(params)
      .then(() => {
        assert(false, 'Action succeeded unexpectedly.');
      })
      .catch(error => {
        assert.deepEqual(JSON.parse(error.body), {
          code: 400,
          message: 'Security hash does not match hash from the server.'
        });
      });
  });

  it('validate error when save auth retrieves no existing keys', () => {
    nock.cleanAll();
    createOpenwhiskMock();
    createSlackMock();

    nock(cloudantHost)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent);

    nock(`https://${cloudantHost.split('@')[1]}`)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, {})
      .put(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .reply(200, {});

    return actionSlackDeploy
      .main(params)
      .then(() => {
        assert(false, 'Action succeeded unexpectedly.');
      })
      .catch(error => {
        assert.deepEqual(JSON.parse(error.body), {
          code: 400,
          message: `No auth db entry for key ${cloudantAuthKey}. Re-run setup.`
        });
      });
  });

  it('validate okay when retrieve doc retrieves no docs', () => {
    nock.cleanAll();
    createOpenwhiskMock();
    createSlackMock();

    nock(cloudantHost)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .replyWithError({ statusCode: 404 });

    nock(`https://${cloudantHost.split('@')[1]}`)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent)
      .put(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .reply(200, {});

    const db = cloudant({
      url: cloudantUrl,
      plugin: 'retry',
      retryAttempts: 5,
      retryTimeout: 1000
    }).use(cloudantAuthDbName);

    return actionSlackDeploy
      .retrieveDoc(db, cloudantAuthKey)
      .then(result => {
        assert.deepEqual(result, {});
      })
      .catch(error => {
        assert(false, error);
      });
  });

  it('validate error when retrieve doc throws an error', () => {
    nock.cleanAll();
    createOpenwhiskMock();
    createSlackMock();

    nock(cloudantHost)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .replyWithError({ statusCode: 400, message: mockError });

    nock(`https://${cloudantHost.split('@')[1]}`)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent)
      .put(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .reply(200, {});

    const db = cloudant({
      url: cloudantUrl,
      plugin: 'retry',
      retryAttempts: 5,
      retryTimeout: 1000
    }).use(cloudantAuthDbName);

    return actionSlackDeploy
      .retrieveDoc(db, cloudantAuthKey)
      .then(() => {
        assert(false, 'Action succeeded unexpectedly.');
      })
      .catch(error => {
        assert.deepEqual(error.description, mockError);
      });
  });

  it('validate error when insert doc throws an error', () => {
    nock.cleanAll();
    createOpenwhiskMock();
    createSlackMock();

    nock(cloudantHost)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent);

    nock(`https://${cloudantHost.split('@')[1]}`)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent)
      .put(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .replyWithError({ error_code: 400, message: mockError });

    const db = cloudant({
      url: cloudantUrl,
      plugin: 'retry',
      retryAttempts: 5,
      retryTimeout: 1000
    }).use(cloudantAuthDbName);

    return actionSlackDeploy
      .insertDoc(db, cloudantAuthKey)
      .then(() => {
        assert(false, 'Action succeeded unexpectedly.');
      })
      .catch(error => {
        assert.deepEqual(error.description, mockError);
      });
  });

  it('validate error when create cloudant object is init on null url', () => {
    return actionSlackDeploy
      .createCloudantObj(null)
      .then(() => {
        assert(false, 'Action succeeded unexpectedly');
      })
      .catch(error => {
        assert.equal(error.message, 'invalid url');
      });
  });

  after(() => {
    delete process.env.__OW_ACTION_NAME;
    process.env.__OW_NAMESPACE = realNamespace;
  });

  function createOpenwhiskMock() {
    return nock(owHost)
      .get(uri => {
        return uri.indexOf(`/api/v1/namespaces/${userNamespace}/packages`) ===
          0;
      })
      .reply(200, packageContent);
  }

  function createSlackMock() {
    return nock(slackHost).get('/api/oauth.access').query(true).reply(200, {
      access_token: 'sample_access_token',
      bot: {
        bot_access_token: 'sample_bot_access_token',
        bot_user_id: 'sample_bot_user_id'
      }
    });
  }

  function createCloudantMock() {
    nock(cloudantHost)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent);

    nock(`https://${cloudantHost.split('@')[1]}`)
      .get(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .query(true)
      .reply(200, authDocContent)
      .put(`/${cloudantAuthDbName}/${cloudantAuthKey}`)
      .reply(200, {});
  }

  function createHmacKey(clientId, clientSecret) {
    const hmacKey = `${clientId}&${clientSecret}`;
    return crypto
      .createHmac('sha256', hmacKey)
      .update('authorize')
      .digest('hex');
  }
});
