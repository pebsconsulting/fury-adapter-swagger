// The main Swagger parsing component that outputs refract.

import _ from 'lodash';
import yaml from 'js-yaml';
import typer from 'media-typer';
import SwaggerParser from 'swagger-parser';
import ZSchema from 'z-schema';
import annotations from './annotations';
import { bodyFromSchema, bodyFromFormParameter } from './generator';
import uriTemplate from './uri-template';
import { baseLink, origin } from './link';
import { pushHeader, pushHeaderObject } from './headers';
import Ast from './ast';
import DataStructureGenerator from './schema';
import convertSchema from './json-schema';
import { FORM_CONTENT_TYPE, isValidContentType, isJsonContentType, isMultiPartFormData, isFormURLEncoded, hasBoundary, parseBoundary } from './media-type';


// Provide a `nextTick` function that either is Node's nextTick or a fallback
// for browsers
function nextTick(cb) {
  if (process && process.nextTick) {
    process.nextTick(cb);
  } else {
    cb();
  }
}

// Test whether a key is a special Swagger extension.
function isExtension(value, key) {
  return _.startsWith(key, 'x-');
}

// The parser holds state about the current parsing environment and converts
// the input Swagger into Refract elements. The `parse` function is its main
// interface.
export default class Parser {
  constructor({ minim, source, generateSourceMap }) {
    // Parser options
    this.minim = minim;
    this.source = source;
    this.generateSourceMap = generateSourceMap;

    // Global scheme requirements
    this.globalSchemes = [];

    // Loaded, dereferenced Swagger API
    this.swagger = null;
    // Refract parse result
    this.result = null;
    // Refract API category
    this.api = null;
    // State of the current parsing path
    this.path = [];
    // Current resource group, if any
    this.group = null;
  }

  parse(done) {
    const {
      Category, ParseResult, SourceMap,
    } = this.minim.elements;
    const swaggerParser = new SwaggerParser();

    this.result = new ParseResult();

    // First, we load the YAML if it is a string, and handle any errors.
    let loaded;
    try {
      loaded = _.isString(this.source) ? yaml.safeLoad(this.source) : this.source;
    } catch (err) {
      // Temporarily disable generateSourceMap while handling error
      // This is because while handling this error we may try to generate
      // source map which further tries to parse YAML to get source
      // maps which causes another warning and raise conditions where we throw
      // an error back to the caller.
      const { generateSourceMap } = this;
      this.generateSourceMap = false;

      this.createAnnotation(
        annotations.CANNOT_PARSE, null,
        (err.reason || 'Problem loading the input'),
      );

      if (err.mark) {
        this.result.first.attributes.set('sourceMap', [
          new SourceMap([[err.mark.position, 1]]),
        ]);
      }

      this.generateSourceMap = generateSourceMap;
      return done(new Error(err.message), this.result);
    }

    // Some sane defaults since these are sometimes left out completely
    if (loaded.info === undefined) {
      loaded.info = {};
    }

    if (loaded.paths === undefined) {
      loaded.paths = {};
    }

    // Next, we dereference and validate the loaded Swagger object. Any schema
    // violations get converted into annotations with source maps.
    const swaggerOptions = {
      $refs: {
        external: false,
      },
    };

    return swaggerParser.validate(loaded, swaggerOptions, (err) => {
      const swagger = swaggerParser.api;
      this.swagger = swaggerParser.api;

      if (err) {
        if (this.swagger === undefined) {
          return done(err, this.result);
        }

        // Non-fatal errors, so let us try and create annotations for them and
        // continue with the parsing as best we can.
        if (err.details) {
          const queue = [err.details];

          while (queue.length) {
            _.forEach(queue[0], (item) => {
              this.createAnnotation(annotations.VALIDATION_ERROR, item.path, item.message);

              if (item.inner) {
                // TODO: I am honestly not sure what the correct behavior is
                // here. Some items will have within them a tree of other items,
                // some of which might contain more info (but it's unclear).
                // Do we treat them as their own error or do something else?
                queue.push(item.inner);
              }
            });

            queue.shift();
          }

          return done(new Error(err.message), this.result);
        }

        // Maybe there is some information in the error itself? Let's check
        // whether it is a messed up reference!
        let location = null;
        const matches = err.message.match(/\$ref pointer "(.*?)"/);

        if (matches) {
          location = [this.source.indexOf(matches[1]), matches[1].length];
        }

        const annotation = this.createAnnotation(annotations.VALIDATION_ERROR, null, err.message);

        if (location !== null) {
          annotation.attributes.set('sourceMap', [
            new SourceMap([location]),
          ]);
        }

        return done(new Error(err.message), this.result);
      }

      try {
        // Root API Element
        this.api = new Category();
        this.api.classes.push('api');
        this.result.push(this.api);

        // By default there are no groups, just the root API element
        this.group = this.api;

        this.handleSwaggerInfo();
        this.handleSwaggerHost();
        this.handleSwaggerAuth();

        this.handleExternalDocs(this.api, swagger.externalDocs);

        this.validateProduces(this.swagger.produces);
        this.validateConsumes(this.swagger.consumes);

        const complete = () => {
          this.handleSwaggerVendorExtensions(this.api, swagger.paths);
          return done(null, this.result);
        };

        // Swagger has a paths object to loop through that describes resources
        // We will run each path on it's own tick since it may take some time
        // and we want to ensure that other events in the event queue are not
        // held up.
        const paths = _.omitBy(swagger.paths, isExtension);
        let pendingPaths = Object.keys(paths).length;

        if (pendingPaths === 0) {
          // If there are no paths, let's go ahead and call the callback.
          return complete();
        }

        return _.forEach(paths, (pathValue, href) => {
          nextTick(() => {
            this.handleSwaggerPath(pathValue, href);
            pendingPaths -= 1;

            if (pendingPaths === 0) {
              // Last path, let's call the completion callback.
              complete();
            }
          });
        });
      } catch (exception) {
        this.createAnnotation(
          annotations.UNCAUGHT_ERROR, null,
          'There was a problem converting the Swagger document',
        );

        return done(exception, this.result);
      }
    });
  }

  // == Internal properties & functions ==

  // Base path (URL) name for the API
  get basePath() {
    return (this.swagger.basePath || '').replace(/[/]+$/, '');
  }

  // Lazy-loaded input AST is made available when we need it. If it can't be
  // loaded, then an annotation is generated with more information about why.
  get ast() {
    if (this.internalAST !== undefined) {
      return this.internalAST;
    }

    if (_.isString(this.source)) {
      try {
        this.internalAST = new Ast(this.source);
      } catch (err) {
        this.internalAST = null;

        let message = 'YAML Syntax Error';
        if (err.problem) {
          message = `${message}: ${err.problem}`;
        }

        const annotation = this.createAnnotation(annotations.AST_UNAVAILABLE, null, message);

        if (err.problem_mark && err.problem_mark.pointer) {
          const SourceMap = this.minim.getElementClass('sourceMap');
          const position = err.problem_mark.pointer;

          annotation.attributes.set('sourceMap', [
            new SourceMap([[position, 1]]),
          ]);
        }
      }
    } else {
      this.internalAST = null;
      this.createAnnotation(
        annotations.AST_UNAVAILABLE, null,
        'Source maps are only available with string input',
      );
    }

    return this.internalAST;
  }

  // This method lets you set the current parsing path and synchronously run
  // a function (e.g. to create an element).
  withPath(...args) {
    let i;
    const originalPath = _.clone(this.path);

    for (i = 0; i < args.length - 1; i += 1) {
      if (args[i] === '..') {
        this.path.pop();
      } else if (args[i] === '.') {
        // do nothing
      } else {
        this.path.push(args[i]);
      }
    }

    args[args.length - 1].bind(this)(this.path);

    this.path = originalPath;
  }

  // This is like `withPath` above, but slices the path before calling by
  // using the first argument as a length (starting at index 0).
  withSlicedPath(...args) {
    const original = this.path.slice(0);

    // First, we slice the path, then call `withPath` and finally reset the path.
    this.path = this.path.slice(0, args[0]);
    this.withPath(...args.slice(1));
    this.path = original;
  }

  handleExternalDocs(element, docs) {
    if (!docs) {
      return;
    }

    baseLink(element, this, 'help', {
      description: docs.description,
      url: docs.url,
      path: this.path.concat(['externalDocs']),
    });
  }

  // Converts the Swagger title and description
  handleSwaggerInfo() {
    const { Copy } = this.minim.elements;

    if (this.swagger.info) {
      this.withPath('info', () => {
        if (this.swagger.info.title) {
          this.withPath('title', () => {
            this.api.title = this.swagger.info.title;

            if (this.generateSourceMap) {
              this.createSourceMap(this.api.meta.get('title'), this.path);
            }

            return this.api.meta.get('title');
          });
        }

        if (this.swagger.info.description) {
          this.withPath('description', () => {
            const description = new Copy(this.swagger.info.description);
            this.api.content.push(description);

            if (this.generateSourceMap) {
              this.createSourceMap(description, this.path);
            }

            return description;
          });
        }

        this.handleSwaggerVendorExtensions(this.api, this.swagger.info);
      });
    }
  }

  // Converts the Swagger hostname and schemes to a Refract host metadata entry.
  handleSwaggerHost() {
    const { Member: MemberElement } = this.minim.elements;

    if (this.swagger.host) {
      this.withPath('host', () => {
        let hostname = this.swagger.host;

        if (this.swagger.schemes) {
          if (this.swagger.schemes.length > 1) {
            this.createAnnotation(
              annotations.DATA_LOST, ['schemes'],
              'Only the first scheme will be used to create a hostname',
            );
          }

          hostname = `${this.swagger.schemes[0]}://${hostname}`;
        }

        const metadata = [];
        const member = new MemberElement('HOST', hostname);

        member.meta.set('classes', ['user']);

        if (this.generateSourceMap) {
          this.createSourceMap(member, this.path);
        }

        metadata.push(member);
        this.api.attributes.set('metadata', metadata);

        return member;
      });
    }
  }

  // Conver api key name into Refract elements
  apiKeyName(element, apiKey) {
    const { Member: MemberElement } = this.minim.elements;
    let config;

    if (apiKey.in === 'query') {
      config = 'queryParameterName';
    } else if (apiKey.in === 'header') {
      config = 'httpHeaderName';
    }

    const member = new MemberElement(config, apiKey.name);

    if (this.generateSourceMap) {
      this.createSourceMap(member, this.path.concat(['name']));
    }

    element.content.push(member);
  }

  // Convert Oauth2 flow into Refract elements
  oauthGrantType(element, flow) {
    const { Member: MemberElement } = this.minim.elements;
    let grantType = flow;

    if (flow === 'password') {
      grantType = 'resource owner password credentials';
    } else if (flow === 'application') {
      grantType = 'client credentials';
    } else if (flow === 'accessCode') {
      grantType = 'authorization code';
    }

    const member = new MemberElement('grantType', grantType);

    if (this.generateSourceMap) {
      this.createSourceMap(member, this.path.concat(['flow']));
    }

    element.content.push(member);
  }

  // Convert OAuth2 scopes into Refract elements
  oauthScopes(element, items) {
    const {
      Member: MemberElement,
      Array: ArrayElement,
      String: StringElement,
    } = this.minim.elements;

    const scopes = new ArrayElement();
    let descriptions = null;
    let scopesList = items;

    if (_.isObject(items) && !_.isArray(items)) {
      descriptions = Object.values(items);
      scopesList = Object.keys(items);
    }

    // If value is not an empty array, then they are scopes
    _.forEach(scopesList, (scopeName, index) => {
      const scope = new StringElement(scopeName);

      if (descriptions) {
        scope.description = descriptions[index];

        if (this.generateSourceMap) {
          this.createSourceMap(scope.meta.get('description'), this.path.concat([scopeName]));
        }
      }

      if (this.generateSourceMap) {
        const value = descriptions ? scopeName : index;
        this.createSourceMap(scope, this.path.concat([value]));
      }

      scopes.content.push(scope);
    });

    if (scopes.length) {
      element.content.push(new MemberElement('scopes', scopes));
    }
  }

  // Conver OAuth2 transition information into Refract elements
  oauthTransitions(element, oauth) {
    const { Transition } = this.minim.elements;

    if (oauth.authorizationUrl) {
      const transition = new Transition();

      transition.relation = 'authorize';
      transition.href = oauth.authorizationUrl;

      if (this.generateSourceMap) {
        this.createSourceMap(transition.attributes.get('href'), this.path.concat(['authorizationUrl']));
        this.createSourceMap(transition.attributes.get('relation'), this.path.concat(['authorizationUrl']));
      }

      element.content.push(transition);
    }

    if (oauth.tokenUrl) {
      const transition = new Transition();

      transition.relation = 'token';
      transition.href = oauth.tokenUrl;

      if (this.generateSourceMap) {
        this.createSourceMap(transition.attributes.get('href'), this.path.concat(['tokenUrl']));
        this.createSourceMap(transition.attributes.get('relation'), this.path.concat(['tokenUrl']));
      }

      element.content.push(transition);
    }
  }

  // Convert a Swagger auth object into Refract elements.
  handleSwaggerAuth() {
    const { Category, AuthScheme } = this.minim.elements;
    const schemes = [];

    if (this.swagger.securityDefinitions) {
      _.keys(this.swagger.securityDefinitions).forEach((name) => {
        this.withPath('securityDefinitions', name, () => {
          const item = this.swagger.securityDefinitions[name];
          const element = new AuthScheme();

          switch (item.type) {
            case 'basic':
              element.element = 'Basic Authentication Scheme';
              break;

            case 'apiKey':
              element.element = 'Token Authentication Scheme';
              this.apiKeyName(element, item);
              break;

            case 'oauth2':
              element.element = 'OAuth2 Scheme';
              this.oauthGrantType(element, item.flow);

              if (item.scopes) {
                this.withPath('scopes', () => {
                  this.oauthScopes(element, item.scopes);
                });
              }

              this.oauthTransitions(element, item);
              break;

            default:
              break;
          }

          element.id = name;

          if (this.generateSourceMap) {
            this.createSourceMap(element.meta.get('id'), this.path);
          }

          if (item['x-summary']) {
            element.title = item['x-summary'];

            if (this.generateSourceMap) {
              this.createSourceMap(element.meta.get('title'), this.path.concat(['x-summary']));
            }
          }

          if (item.description) {
            element.description = item.description;

            if (this.generateSourceMap) {
              this.createSourceMap(element.meta.get('description'), this.path.concat(['description']));
            }
          }

          schemes.push(element);

          this.handleSwaggerVendorExtensions(element, item);
        });
      });
    }

    if (schemes.length) {
      const category = new Category();

      category.meta.set('classes', ['authSchemes']);
      category.content = schemes;

      this.api.content.push(category);
    }

    if (!this.swagger.security) {
      return;
    }

    this.handleSwaggerSecurity(this.swagger.security, this.globalSchemes);
  }

  handleSwaggerSecurity(security, schemes) {
    const { AuthScheme } = this.minim.elements;

    _.forEach(security, (item, index) => {
      _.keys(item).forEach((name) => {
        this.withPath('security', index, name, () => {
          const element = new AuthScheme();

          // If value is not an empty array, then they are scopes
          this.oauthScopes(element, item[name]);

          if (this.generateSourceMap) {
            this.createSourceMap(element, this.path);
          }

          element.element = name;
          schemes.push(element);
        });
      });
    });
  }

  handleSwaggerTransitionAuth(methodValue) {
    const schemes = [];

    if (!methodValue.security) {
      return this.globalSchemes;
    }

    this.handleSwaggerSecurity(methodValue.security, schemes);

    return schemes;
  }

  // Convert a Swagger path into a Refract resource.
  handleSwaggerPath(pathValue, href) {
    const { Copy, Resource } = this.minim.elements;
    const resource = new Resource();

    this.withPath('paths', href, () => {
      // Provide users with a way to add a title to a resource in Swagger
      if (pathValue['x-summary']) {
        this.withPath('x-summary', () => {
          resource.title = String(pathValue['x-summary']);

          if (this.generateSourceMap) {
            this.createSourceMap(resource.meta.get('title'), this.path);
          }

          return resource.meta.get('title');
        });
      }

      // Provide users a way to add a description to a resource in Swagger
      if (pathValue['x-description']) {
        this.withPath('x-description', () => {
          const resourceDescription = new Copy(pathValue['x-description']);
          resource.push(resourceDescription);

          if (this.generateSourceMap) {
            this.createSourceMap(resourceDescription, this.path);
          }

          return resourceDescription;
        });
      }

      if (this.useResourceGroups()) {
        this.updateResourceGroup(pathValue['x-group-name']);
      }

      this.group.content.push(resource);

      const pathObjectParameters = pathValue.parameters || [];
      const resourceHrefVariables = this.createHrefVariables(pathObjectParameters);

      if (resourceHrefVariables) {
        resource.hrefVariables = resourceHrefVariables;
      }

      // Set the resource-wide URI template, which can further be overridden
      // by individual transition URI templates. When creating a transition
      // below, we *only* set the transition URI template if it differs from
      // the one we've generated here.
      resource.href = uriTemplate(this.basePath, href, pathObjectParameters);

      if (this.generateSourceMap) {
        this.createSourceMap(resource.attributes.get('href'), this.path);
      }

      const relevantMethods = _.chain(pathValue)
        .omit('parameters', '$ref')
        .omitBy(isExtension)
        .value();

      // Each path is an object with methods as properties
      _.forEach(relevantMethods, (methodValue, method) => {
        this.handleSwaggerMethod(resource, href, pathObjectParameters, methodValue, method);
      });

      this.handleSwaggerVendorExtensions(resource, pathValue);

      return resource;
    });
  }

  // Converts all unknown Swagger vendor extensions from an object into a API Element extension
  handleSwaggerVendorExtensions(element, object) {
    const extensions = _.chain(object)
      .pickBy(isExtension)
      .omit('x-description', 'x-summary', 'x-group-name')
      .value();

    if (Object.keys(extensions).length > 0) {
      const { Link, Extension } = this.minim.elements;

      const profileLink = new Link();
      profileLink.relation = 'profile';
      profileLink.href = 'https://help.apiary.io/profiles/api-elements/vendor-extensions/';

      const extension = new Extension(extensions);
      extension.links = [profileLink];
      element.content.push(extension);
    }
  }

  // Convert a Swagger method into a Refract transition.
  handleSwaggerMethod(resource, href, resourceParams, methodValue, method) {
    const { Copy, Transition } = this.minim.elements;
    const transition = new Transition();

    resource.content.push(transition);

    this.withPath(method, () => {
      const schemes = this.handleSwaggerTransitionAuth(methodValue);

      this.validateProduces(methodValue.produces);
      this.validateConsumes(methodValue.consumes);

      this.handleExternalDocs(transition, methodValue.externalDocs);

      const transitionParams = methodValue.parameters || [];

      const queryParams = transitionParams.filter(parameter => parameter.in === 'query');

      // Here we generate a URI template specific to this transition. If it
      // is different from the resource URI template, then we set the
      // transition's `href` attribute.
      const hrefForTransition = uriTemplate(this.basePath, href, resourceParams, queryParams);

      if (hrefForTransition !== resource.href.toValue()) {
        transition.href = hrefForTransition;
      }

      if (methodValue.summary) {
        this.withPath('summary', () => {
          transition.title = methodValue.summary;

          if (this.generateSourceMap) {
            this.createSourceMap(transition.meta.get('title'), this.path);
          }

          return transition.meta.get('title');
        });
      }

      if (methodValue.description) {
        this.withPath('description', () => {
          const description = new Copy(methodValue.description);
          transition.push(description);

          if (this.generateSourceMap) {
            this.createSourceMap(description, this.path);
          }

          return description;
        });
      }

      if (methodValue.operationId) {
        // TODO: Add a source map?
        transition.id = methodValue.operationId;
      }

      // For each uriParameter, create an hrefVariable
      const methodHrefVariables = this.createHrefVariables(transitionParams);
      if (methodHrefVariables) {
        transition.hrefVariables = methodHrefVariables;
      }

      // Currently, default responses are not supported in API Description format
      const relevantResponses = _.chain(methodValue.responses)
        .omit('default')
        .omitBy(isExtension)
        .value();

      if (methodValue.responses && methodValue.responses.default) {
        this.withPath('responses', 'default', (path) => {
          this.createAnnotation(
            annotations.DATA_LOST, path,
            'Default response is not yet supported',
          );
        });
      }

      if (_.keys(relevantResponses).length === 0) {
        if (transitionParams.filter(p => p.in === 'body').length) {
          // Create an empty successful response so that the request/response
          // pair gets properly generated. In the future we may want to
          // refactor the code below as this is a little weird.
          relevantResponses.null = {};
        } else {
          this.createTransaction(transition, method, schemes);
        }
      }

      // Transactions are created for each response in the document
      _.forEach(relevantResponses, (responseValue, statusCode) => {
        this.handleSwaggerResponse(
          transition, method, methodValue,
          transitionParams, responseValue, statusCode,
          schemes, resourceParams,
        );
      });

      this.handleSwaggerVendorExtensions(transition, methodValue);

      return transition;
    });
  }

  // Returns all of the content types for a request
  // Request content types include all consumes types
  // Returns `[null]` when there are no content types
  gatherRequestContentTypes(methodValue) {
    const contentTypes = (methodValue.consumes || this.swagger.consumes || [])
      .filter(isValidContentType);

    if (contentTypes.length === 0) {
      return [null];
    }

    return contentTypes;
  }

  // Returns all of the content types for a response
  // Response content types include all example types OR the first JSON content type
  // Returns `[null]` when there are no content types
  gatherResponseContentTypes(methodValue, examples) {
    let contentTypes = [];

    if (examples && Object.keys(examples).length > 0) {
      contentTypes = Object.keys(examples);
    } else {
      const produces = (methodValue.produces || this.swagger.produces || []);
      const jsonContentTypes = produces.filter(isJsonContentType);

      if (jsonContentTypes.length > 0) {
        contentTypes = [jsonContentTypes[0]];
      }
    }

    contentTypes = contentTypes.filter(isValidContentType);

    if (contentTypes.length === 0) {
      return [null];
    }

    return contentTypes;
  }

  // Convert a Swagger response & status code into Refract transactions.
  handleSwaggerResponse(
    transition, method, methodValue, transitionParams,
    responseValue, statusCode, schemes, resourceParams,
  ) {
    const requestContentTypes = this.gatherRequestContentTypes(methodValue);
    const responseContentTypes = this
      .gatherResponseContentTypes(methodValue, responseValue.examples);

    responseContentTypes.forEach((responseContentType) => {
      let responseBody;

      if (responseContentType && responseValue.examples &&
          responseValue.examples[responseContentType]) {
        responseBody = responseValue.examples[responseContentType];
      }

      requestContentTypes.forEach((requestContentType) => {
        const transaction = this.createTransaction(transition, method, schemes);

        this.handleSwaggerExampleRequest(
          transaction, methodValue, transitionParams,
          resourceParams, requestContentType, responseContentType, responseBody === undefined,
        );

        this.handleSwaggerExampleResponse(
          transaction, methodValue, responseValue,
          statusCode, responseBody, responseContentType,
        );
      });
    });
  }

  // Convert a Swagger example into a Refract request.
  handleSwaggerExampleRequest(
    transaction, methodValue, transitionParams, resourceParams,
    requestContentType, responseContentType, contentTypeFromProduces,
  ) {
    let contentType = requestContentType;
    const { request } = transaction;

    this.withPath(() => {
      const consumeIsJson = contentType && isJsonContentType(contentType);
      const consumeIsMultipartFormData = contentType && isMultiPartFormData(contentType);

      if (consumeIsMultipartFormData && !hasBoundary(contentType)) {
        // When multipart/form-data conntent type doesn't have a boundary
        // add a default one `BOUNDARY` which hopefully isn't found
        // in an example content. `parseBoundary` will provide the default.
        contentType += `; boundary=${parseBoundary(contentType)}`;
      }

      if (contentType) {
        pushHeader('Content-Type', contentType, request, this, 'consumes-content-type');
      }

      if (responseContentType) {
        if (contentTypeFromProduces) {
          pushHeader('Accept', responseContentType, request, this, 'produces-accept');
        } else {
          pushHeader('Accept', responseContentType, request, this);
        }
      }

      const formParams = [];
      let formParamsSchema = { type: 'object', properties: {}, required: [] };

      const parametersGenerator = {};

      _.forEach([
        [resourceParams, '..'],
        [transitionParams, '.'],
      ], (parameters) => {
        _.forEach(parameters[0], (param, index) => {
          switch (param.in) {
            case 'header':
              _.set(parametersGenerator, [param.in, param.name], _.bind(this.withPath, this, parameters[1], 'parameters', index, () => {
                pushHeaderObject(param.name, param, request, this);
              }));
              break;

            case 'body':
              _.set(parametersGenerator, [param.in, param.name], _.bind(this.withPath, this, parameters[1], 'parameters', index, () => {
                if (param['x-example']) {
                  this.withPath('x-example', () => {
                    this.createAnnotation(
                      annotations.VALIDATION_ERROR, this.path,
                      'The \'x-example\' property isn\'t allowed for body parameters - use \'schema.example\' instead',
                    );
                  });
                }

                this.withPath('schema', () => {
                  if (consumeIsJson) {
                    bodyFromSchema(param.schema, request, this, contentType);
                  }

                  this.pushSchemaAsset(param.schema, request, this.path);
                });
              }));
              break;

            case 'formData':
              _.set(parametersGenerator, [param.in, param.name], _.bind(this.withPath, this, parameters[1], 'parameters', index, () => {
                this.formDataParameterCheck(param);
                formParamsSchema = bodyFromFormParameter(param, formParamsSchema);
                const member = this.convertParameterToMember(param);
                formParams.push(member);
              }));
              break;

            default:
          }
        });
      });

      _.forEach(parametersGenerator, (paramType) => {
        _.forEach(paramType, (invoke) => {
          invoke();
        });
      });

      if (!contentType || consumeIsMultipartFormData || isFormURLEncoded(contentType)) {
        this.generateFormParameters(formParams, formParamsSchema, request, contentType);
      }

      // Using form parameters instead of body? We will convert those to
      // data structures and will generate form-urlencoded body.
      return request;
    });
  }

  generateFormParameters(parameters, schema, request, contentType) {
    if (_.isEmpty(parameters)) {
      return;
    }

    const { DataStructure, Object: ObjectElement } = this.minim.elements;

    if (!contentType) {
      // No content type was provided, lets default to first form
      pushHeader('Content-Type', FORM_CONTENT_TYPE, request, this, 'form-data-content-type');
    }

    bodyFromSchema(schema, request, this, contentType || FORM_CONTENT_TYPE);

    // Generating data structure
    const dataStructure = new DataStructure();

    // A form is essentially an object with key/value members
    const dataObject = new ObjectElement();

    _.forEach(parameters, (param) => {
      dataObject.content.push(param);
    });

    dataStructure.content = dataObject;
    request.content.push(dataStructure);
  }

  formDataParameterCheck(param) {
    if (param.type === 'array') {
      this.createAnnotation(
        annotations.DATA_LOST, this.path,
        'Arrays in form parameters are not fully supported yet',
      );

      return;
    }

    if (param.allowEmptyValue) {
      this.createAnnotation(
        annotations.DATA_LOST, this.path,
        'The allowEmptyValue flag is not fully supported yet',
      );
    }
  }

  // Convert a Swagger example into a Refract response.
  handleSwaggerExampleResponse(
    transaction, methodValue, responseValue,
    statusCode, responseBody, contentType,
  ) {
    const { Asset, Copy } = this.minim.elements;
    const { response } = transaction;

    this.withPath('responses', statusCode, () => {
      if (responseValue.description) {
        const description = new Copy(responseValue.description);
        response.content.push(description);

        if (this.generateSourceMap) {
          this.createSourceMap(description, this.path.concat(['description']));
        }
      }

      if (contentType) {
        if (responseValue.examples && responseValue.examples[contentType]) {
          this.withPath('examples', contentType, () => {
            pushHeader('Content-Type', contentType, response, this);
          });
        } else {
          pushHeader('Content-Type', contentType, response, this, 'produces-content-type');
        }
      }

      const isJsonResponse = isJsonContentType(contentType);

      if (responseValue.headers) {
        this.updateHeaders(response, responseValue.headers);
      }

      this.withPath('examples', () => {
        // Responses can have bodies
        if (responseBody !== undefined) {
          this.withPath(contentType, () => {
            let formattedResponseBody = responseBody;
            let serialized = true;

            if (typeof responseBody !== 'string') {
              try {
                formattedResponseBody = JSON.stringify(responseBody, null, 2);
              } catch (exception) {
                this.createAnnotation(annotations.DATA_LOST, this.path, 'Circular references in examples are not yet supported.');
                serialized = false;
              }
            }

            if (serialized) {
              const bodyAsset = new Asset(formattedResponseBody);
              bodyAsset.classes.push('messageBody');

              if (this.generateSourceMap) {
                this.createSourceMap(bodyAsset, this.path);
              }

              response.content.push(bodyAsset);
            }
          });
        }

        // Responses can have schemas in Swagger
        const exampleSchema = responseValue.examples && responseValue.examples.schema;
        const schema = responseValue.schema || exampleSchema;

        if (schema) {
          let args;

          if (responseValue.examples && responseValue.examples.schema) {
            args = [5, 'examples', 'schema'];
          } else {
            args = [5, 'schema'];
          }

          this.withSlicedPath(...args.concat([() => {
            if (isJsonResponse && responseBody === undefined) {
              bodyFromSchema(schema, response, this, contentType);
            }

            this.pushSchemaAsset(schema, response, this.path);
          }]));
        }

        if (statusCode !== 'null') {
          response.statusCode = statusCode;

          if (this.generateSourceMap) {
            this.createSourceMap(response.attributes.get('statusCode'), this.path.slice(0, -1));
          }
        }
      });


      this.handleSwaggerVendorExtensions(response, responseValue);

      return response;
    });
  }

  // Takes in an `payload` element and a list of Swagger headers. Adds
  // the Swagger headers to the headers element in the payload
  updateHeaders(payload, httpHeaders) {
    _.forEach(_.keys(httpHeaders), (headerName) => {
      if (Object.prototype.hasOwnProperty.call(httpHeaders, headerName)) {
        // eslint-disable-next-line no-loop-func
        this.withPath('headers', headerName, () => {
          pushHeaderObject(headerName, httpHeaders[headerName], payload, this);
        });
      }
    });
  }

  // Test whether tags can be treated as resource groups, and if so it sets a
  // group name for each resource (used later to create groups).
  useResourceGroups() {
    const tags = [];

    if (this.swagger.paths) {
      _.forEach(this.swagger.paths, (path) => {
        let tag = null;

        if (path) {
          const operations = _.omitBy(path, isExtension);

          // eslint-disable-next-line consistent-return
          _.forEach(operations, (operation) => {
            if (operation.tags && operation.tags.length) {
              if (operation.tags.length > 1) {
                // Too many tags... each resource can only be in one group!
                return false;
              }

              if (tag === null) {
                [tag] = operation.tags;
              } else if (tag !== operation.tags[0]) {
                // Non-matching tags... can't have a resource in multiple groups!
                return false;
              }
            }
          });
        }

        if (tag) {
          // eslint-disable-next-line no-param-reassign
          path['x-group-name'] = tag;
          tags.push(tag);
        }
      });
    }

    return tags.length > 0;
  }

  // Update the current group by either selecting or creating it.
  updateResourceGroup(name) {
    const { Category, Copy } = this.minim.elements;

    if (name) {
      this.group = this.api.find(el => el.element === 'category' && el.classes.contains('resourceGroup') && el.title.toValue() === name).first;

      if (!this.group) {
        // TODO: Source maps for these groups. The problem is that the location
        // may not always make sense. Do we point to the tag description,
        // the resource, or the transition?
        this.group = new Category();
        this.group.title = name;
        this.group.classes.push('resourceGroup');

        if (this.swagger.tags && _.isArray(this.swagger.tags)) {
          _.forEach(this.swagger.tags, (tag) => {
            if (tag.name === name && tag.description) {
              this.group.content.push(new Copy(tag.description));
            }

            this.handleExternalDocs(this.group, tag.externalDocs);
          });
        }

        this.api.content.push(this.group);
      }
    }
  }

  /* eslint-disable class-methods-use-this */
  schemaForParameterValue(parameter) {
    const schema = {
      type: parameter.type,
    };

    if (schema.type === 'integer') {
      schema.type = 'number';
    }

    if (parameter.items) {
      schema.items = parameter.items;
    }

    return schema;
  }

  typeForParameter(parameter) {
    const {
      Array: ArrayElement, Boolean: BooleanElement, Number: NumberElement,
      String: StringElement,
    } = this.minim.elements;

    const types = {
      string: StringElement,
      number: NumberElement,
      integer: NumberElement,
      boolean: BooleanElement,
      array: ArrayElement,
      file: StringElement,
    };

    return types[parameter.type];
  }

  convertValueToElement(value, schema) {
    const validator = new ZSchema();
    let element;

    if (validator.validate(value, schema)) {
      element = this.minim.toElement(value);

      if (this.generateSourceMap) {
        this.createSourceMap(element, this.path);
      }
    } else {
      validator.getLastError().details.forEach((detail) => {
        this.createAnnotation(annotations.VALIDATION_WARNING, this.path, detail.message);
      });

      // Coerce parameter to correct type
      if (schema.type === 'string') {
        if (typeof value === 'number' || typeof value === 'boolean') {
          element = new this.minim.elements.String(String(value));
        }
      }
    }

    return element;
  }

  // Convert a Swagger parameter into a Refract element.
  convertParameterToElement(parameter, setAttributes = false) {
    const { Array: ArrayElement, Enum: EnumElement } = this.minim.elements;

    const Type = this.typeForParameter(parameter);
    const schema = this.schemaForParameterValue(parameter);

    let element = new Type();

    if (parameter['x-example'] !== undefined) {
      this.withPath('x-example', () => {
        const value = this.convertValueToElement(parameter['x-example'], schema);

        if (value) {
          if (parameter.enum) {
            value.attributes.set('typeAttributes', ['fixed']);
          }

          element = value;
        }
      });
    }

    if (parameter.enum) {
      const enumerations = new ArrayElement();

      parameter.enum.forEach((value, index) => {
        this.withPath('enum', index, () => {
          const enumeration = this.convertValueToElement(value, schema);

          if (enumeration) {
            enumeration.attributes.set('typeAttributes', ['fixed']);
            enumerations.push(enumeration);
          }
        });
      });


      if (enumerations.length > 0) {
        // We should only wrap the existing element in an enumeration
        // iff there was valid enumeations. When there is enuerations
        // and they are all invalid, let's discard the enumeration.
        // The user already got a warning about it which is
        // raised from `convertValueToElement`.

        if (element.toValue()) {
          element = new EnumElement(element);
        } else {
          element = new EnumElement();
        }

        element.enumerations = enumerations;
      }
    }

    if (parameter.default) {
      this.withPath('default', () => {
        let value = this.convertValueToElement(parameter.default, schema);

        if (value) {
          if (parameter.enum) {
            value.attributes.set('typeAttributes', ['fixed']);
            value = new EnumElement(value);
          }

          element.attributes.set('default', value);
        }
      });
    }

    if (parameter.type === 'array' && parameter.items && parameter.items.type && element.content.length === 0) {
      this.withPath('items', () => {
        element.content = [this.convertParameterToElement(parameter.items, true)];
      });
    }

    if (this.generateSourceMap) {
      this.createSourceMap(element, this.path);
    }

    if (setAttributes) {
      if (parameter.description) {
        element.description = parameter.description;

        if (this.generateSourceMap) {
          this.createSourceMap(element.meta.get('description'), this.path.concat(['description']));
        }
      }

      if (parameter.required) {
        element.attributes.set('typeAttributes', ['required']);
      }
    }

    return element;
  }

  // Convert a Swagger parameter into a Refract member element for use in an
  // object element (or subclass).
  convertParameterToMember(parameter) {
    const MemberElement = this.minim.getElementClass('member');
    const memberValue = this.convertParameterToElement(parameter);
    const member = new MemberElement(parameter.name, memberValue);

    if (this.generateSourceMap) {
      this.createSourceMap(member, this.path);
    }

    if (parameter.description) {
      member.description = parameter.description;

      if (this.generateSourceMap) {
        this.createSourceMap(member.meta.get('description'), this.path.concat(['description']));
      }
    }

    if (parameter.required) {
      member.attributes.set('typeAttributes', ['required']);
    }

    return member;
  }

  // Make a new source map for the given element
  createSourceMap(element, path) {
    if (this.ast) {
      const SourceMap = this.minim.getElementClass('sourceMap');
      const position = this.ast.getPosition(path);

      // eslint-disable-next-line no-restricted-globals
      if (position && !isNaN(position.start) && !isNaN(position.end)) {
        element.attributes.set('sourceMap', [
          new SourceMap([[position.start, position.end - position.start]]),
        ]);
      }
    }
  }

  // Make a new annotation for the given path and message
  createAnnotation(info, path, message) {
    const { Annotation } = this.minim.elements;

    const annotation = new Annotation(message);
    annotation.classes.push(info.type);
    annotation.code = info.code;

    this.result.content.push(annotation);

    if (info.fragment) {
      origin(info.fragment, annotation, this);
    }

    if (path && this.ast) {
      this.createSourceMap(annotation, path);
    }

    return annotation;
  }

  // Create a new HrefVariables element from a parameter list. Returns either
  // the new HrefVariables element or `undefined`.
  createHrefVariables(params) {
    const { HrefVariables } = this.minim.elements;
    const hrefVariables = new HrefVariables();

    _.forEach(params, (parameter, index) => {
      this.withPath('parameters', index, () => {
        let member;
        const format = parameter.collectionFormat || 'csv';

        // Adding a warning if format is not supported
        if (!['multi', 'csv'].includes(format)) {
          this.createAnnotation(
            annotations.DATA_LOST, this.path,
            `Parameters of collection format '${format}' are not supported`,
          );
        }

        if (parameter.in === 'query' || parameter.in === 'path') {
          member = this.convertParameterToMember(parameter);
          hrefVariables.content.push(member);
        }

        return member;
      });
    });

    return hrefVariables.length ? hrefVariables : undefined;
  }

  // Create a Refract asset element containing JSON Schema and push into payload
  pushSchemaAsset(schema, payload, path) {
    let handledSchema = false;

    try {
      const jsonSchema = convertSchema(schema);
      const Asset = this.minim.getElementClass('asset');
      const schemaAsset = new Asset(JSON.stringify(jsonSchema));

      schemaAsset.classes.push('messageBodySchema');
      schemaAsset.contentType = 'application/schema+json';

      if (this.generateSourceMap) {
        this.createSourceMap(schemaAsset, path);
      }

      this.handleExternalDocs(schemaAsset, schema.externalDocs);

      payload.content.push(schemaAsset);
      handledSchema = true;
    } catch (exception) {
      this.createAnnotation(
        annotations.DATA_LOST, path,
        'Circular references in schema are not yet supported',
      );
    }

    if (handledSchema) {
      try {
        const generator = new DataStructureGenerator(this.minim);
        const dataStructure = generator.generateDataStructure(schema);
        if (dataStructure) {
          payload.content.push(dataStructure);
        }
      } catch (exception) {
        // TODO: Expose errors once feature is more-complete
      }
    }
  }

  // Create a new Refract transition element with a blank request and response.
  createTransaction(transition, method, schemes) {
    const { HttpRequest, HttpResponse, HttpTransaction } = this.minim.elements;
    const transaction = new HttpTransaction();
    transaction.content = [new HttpRequest(), new HttpResponse()];

    if (transition) {
      transition.content.push(transaction);
    }

    if (method) {
      transaction.request.method = method.toUpperCase();

      if (this.generateSourceMap) {
        this.createSourceMap(transaction.request.attributes.get('method'), this.path);
      }
    }

    if (schemes.length) {
      transaction.attributes.set('authSchemes', schemes.map(scheme => scheme.clone()));
    }

    return transaction;
  }

  validateProduces(produces) {
    if (produces) {
      this.withPath('produces', () => {
        this.validateContentTypes(produces);
      });
    }
  }

  validateConsumes(consumes) {
    if (consumes) {
      this.withPath('consumes', () => {
        this.validateContentTypes(consumes);
      });
    }
  }

  validateContentTypes(contentTypes) {
    contentTypes.forEach((contentType) => {
      try {
        typer.parse(contentType);
      } catch (e) {
        const index = contentTypes.indexOf(contentType);
        this.withPath(index, () => {
          this.createAnnotation(
            annotations.VALIDATION_WARNING, this.path,
            `Invalid content type '${contentType}', ${e.message}`,
          );
        });
      }
    });
  }
}

